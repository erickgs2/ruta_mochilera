import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import type { DbTransactionClient } from '@rm/db';
import { fail, ok } from '@rm/shared-utils';
import { registerCashPayment } from './counter-payment';
import { adjustCredit, creditBalance, creditFromExpiration } from './credit-service';
import type { ReviveReservation } from './revival';
import { seedReservation, seedStaff } from './test-fixtures';

const db = withTestDb();

let staffId: string;
let queue: PgBoss;

beforeAll(async () => {
  await prepareTestDb();
  queue = await withTestQueue();
});

beforeEach(async () => {
  await resetDatabase(db);
  await resetTestQueue();
  staffId = await seedStaff(db);
});

afterAll(async () => {
  await closeTestQueue();
  await closeTestDb();
});

describe('registerCashPayment', () => {
  it('records numbered cash by the staff member, activates a HELD reservation and queues the receipt', async () => {
    const reservation = await seedReservation(db, staffId, { minimumDepositCents: 100_000 });

    const paid = await registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 100_000, actorId: staffId });

    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.value).toMatchObject({ method: 'CASH', provider: 'MANUAL', status: 'SUCCEEDED', amountCents: 100_000 });
    expect(paid.value.receiptNumber).toMatch(/^RM-\d{4}-000001$/);
    expect(paid.value.paidAt).not.toBeNull();
    const stored = await db.payment.findUniqueOrThrow({ where: { id: paid.value.id } });
    expect(stored.recordedById).toBe(staffId);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      status: 'ACTIVE',
      holdExpiresAt: null,
      paidCents: 100_000,
    });
    expect((await queue.findJobs(SEND_RECEIPT_JOB, {})).map((job) => job.data)).toEqual([{ paymentId: paid.value.id }]);
  });

  it('leaves a HELD reservation held when the deposit is not reached', async () => {
    const reservation = await seedReservation(db, staffId, { minimumDepositCents: 100_000 });

    await registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 50_000, actorId: staffId });

    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('HELD');
  });

  it('refuses zero, more than the balance, and a reservation that is not live', async () => {
    const reservation = await seedReservation(db, staffId, { totalPriceCents: 500_000, paidCents: 400_000, status: 'ACTIVE' });
    const cancelled = await seedReservation(db, staffId, { status: 'CANCELLED' });

    expect(await registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 0, actorId: staffId })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(
      await registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 100_001, actorId: staffId })
    ).toMatchObject({ ok: false, error: { code: 'PAYMENT_EXCEEDS_BALANCE' } });
    expect(
      await registerCashPayment(db, queue, { reservationId: cancelled.id, amountCents: 1_000, actorId: staffId })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
    expect(await db.payment.count()).toBe(0);
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);
  });

  it('refuses a hold whose time already ran out', async () => {
    const reservation = await seedReservation(db, staffId);
    await db.reservation.update({ where: { id: reservation.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });

    expect(
      await registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 1_000, actorId: staffId })
    ).toMatchObject({ ok: false, error: { code: 'HOLD_EXPIRED' } });
  });
});

/**
 * A stand-in for `reviveReservationSeat` (`@rm/domain-reservations`): this
 * library must not import that one, so the seat half is simulated and the
 * real one is exercised together with this in `expire-holds.spec.ts`.
 */
const reviveStub: ReviveReservation = async (tx, { reservationId }) => {
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  const live =
    reservation.status === 'ACTIVE' ||
    (reservation.status === 'HELD' && reservation.holdExpiresAt !== null && reservation.holdExpiresAt > new Date());
  if (live) return ok({ outcome: 'LIVE' as const });
  if (reservation.status === 'CANCELLED') return fail('INVALID_STATUS_TRANSITION');
  await tx.reservation.update({
    where: { id: reservationId },
    data: { status: 'HELD', holdExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return ok({ outcome: 'REVIVED' as const, previousStatus: reservation.status === 'EXPIRED' ? ('EXPIRED' as const) : ('HELD' as const) });
};
const soldOutStub: ReviveReservation = async () => fail('TRIP_SOLD_OUT');

describe('registerCashPayment reviving a reservation whose hold ran out (decision 13)', () => {
  /** An `EXPIRED` reservation that had received `paidCents` before it expired, already credited. */
  async function expiredWithPayments(paidCents: number, minimumDepositCents = 100_000) {
    const reservation = await seedReservation(db, staffId, { status: 'EXPIRED', paidCents, minimumDepositCents });
    await db.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents: paidCents,
        method: 'CASH',
        status: 'SUCCEEDED',
        provider: 'MANUAL',
        paidAt: new Date(),
      },
    });
    await db.$transaction((tx: DbTransactionClient) =>
      creditFromExpiration(tx, { customerId: reservation.customerId, reservationId: reservation.id, paidCents })
    );
    return reservation;
  }

  /** Credit held plus what a live reservation counts is exactly what was paid: the money is never in two places. */
  async function expectMoneyConserved(reservationId: string) {
    const reservation = await db.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const paid = await db.payment.aggregate({ where: { reservationId, status: 'SUCCEEDED' }, _sum: { amountCents: true } });
    const live = reservation.status === 'HELD' || reservation.status === 'ACTIVE';
    const credit = await creditBalance(db, reservation.customerId);
    expect(credit + (live ? reservation.paidCents : 0)).toBe(paid._sum.amountCents ?? 0);
  }

  const cash = (reservationId: string, amountCents: number, revive: ReviveReservation = reviveStub) =>
    registerCashPayment(db, queue, { reservationId, amountCents, actorId: staffId }, revive);

  it('revives an EXPIRED reservation, takes its credit back and activates it when the cash covers the deposit', async () => {
    const reservation = await expiredWithPayments(40_000);

    const paid = await cash(reservation.id, 60_000);

    expect(paid.ok).toBe(true);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      status: 'ACTIVE',
      holdExpiresAt: null,
      paidCents: 100_000,
    });
    expect(await creditBalance(db, reservation.customerId)).toBe(0);
    expect(await db.customerCreditEntry.count({ where: { kind: 'REVIVAL', reservationId: reservation.id } })).toBe(1);
    await expectMoneyConserved(reservation.id);
  });

  it('leaves it HELD with a fresh hold when the cash does not reach the deposit, still without keeping the money twice', async () => {
    const reservation = await expiredWithPayments(40_000);

    const paid = await cash(reservation.id, 20_000);

    expect(paid.ok).toBe(true);
    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('HELD');
    expect(after.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.paidCents).toBe(60_000);
    expect(await creditBalance(db, reservation.customerId)).toBe(0);
    await expectMoneyConserved(reservation.id);
  });

  it('revives a HELD reservation whose time ran out before the job expired it, with no credit to take back', async () => {
    const reservation = await seedReservation(db, staffId);
    await db.reservation.update({ where: { id: reservation.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });

    const paid = await cash(reservation.id, 100_000);

    expect(paid.ok).toBe(true);
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('ACTIVE');
    expect(await db.customerCreditEntry.count()).toBe(0);
  });

  it('is TRIP_SOLD_OUT with nothing written when no seat is left', async () => {
    const reservation = await expiredWithPayments(40_000);

    const paid = await cash(reservation.id, 60_000, soldOutStub);

    expect(paid).toMatchObject({ ok: false, error: { code: 'TRIP_SOLD_OUT' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, reservation.customerId)).toBe(40_000);
    expect(await db.payment.count()).toBe(1);
    await expectMoneyConserved(reservation.id);
  });

  it('is CREDIT_INSUFFICIENT and undoes the revival when the customer already spent that credit', async () => {
    const reservation = await expiredWithPayments(40_000);
    await adjustCredit(db, { customerId: reservation.customerId, amountCents: -30_000, reason: 'Spent elsewhere', actorId: staffId });

    const paid = await cash(reservation.id, 60_000);

    expect(paid).toMatchObject({ ok: false, error: { code: 'CREDIT_INSUFFICIENT' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, reservation.customerId)).toBe(10_000);
    expect(await db.customerCreditEntry.count({ where: { kind: 'REVIVAL' } })).toBe(0);
    expect(await db.payment.count()).toBe(1);
  });

  it('undoes the revival and the credit it took back when the cash then exceeds the balance', async () => {
    const reservation = await expiredWithPayments(40_000);

    const paid = await cash(reservation.id, 500_000);

    expect(paid).toMatchObject({ ok: false, error: { code: 'PAYMENT_EXCEEDS_BALANCE' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, reservation.customerId)).toBe(40_000);
    await expectMoneyConserved(reservation.id);
  });

  it('never revives a CANCELLED reservation: the money of a customer with no live reservation is credit', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'CANCELLED' });

    expect(await cash(reservation.id, 1_000)).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('CANCELLED');
  });
});
