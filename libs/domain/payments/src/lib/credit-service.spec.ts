import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient } from '@rm/db';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import {
  addCreditEntry,
  adjustCredit,
  applyCreditToReservation,
  creditBalance,
  creditFromCancellation,
  listCreditEntries,
  refundCredit,
} from './credit-service';
import { seedCustomer, seedReservation, seedStaff } from './test-fixtures';

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

async function giveCredit(customerId: string, amountCents: number): Promise<void> {
  const result = await adjustCredit(db, { customerId, amountCents, reason: 'Opening balance', actorId: staffId });
  if (!result.ok) throw new Error(result.error.code);
}

describe('creditFromCancellation', () => {
  it('turns what was paid into credit, once per payment', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'CANCELLED', paidCents: 150_000 });

    await db.$transaction((tx: DbTransactionClient) =>
      creditFromCancellation(tx, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        amountCents: 150_000,
        actorId: staffId,
      })
    );

    const credit = await listCreditEntries(db, reservation.customerId);
    expect(credit.ok && credit.value.balanceCents).toBe(150_000);
    expect(credit.ok && credit.value.entries).toMatchObject([
      { kind: 'CANCELLATION', amountCents: 150_000, reservationId: reservation.id },
    ]);
  });

  it('writes nothing when nothing was paid', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'CANCELLED' });

    await db.$transaction((tx: DbTransactionClient) =>
      creditFromCancellation(tx, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        amountCents: 0,
      })
    );

    expect(await db.customerCreditEntry.count()).toBe(0);
  });

  it('credits one late payment only once, however many times it is delivered', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'CANCELLED' });
    const payment = await db.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents: 50_000,
        method: 'OXXO',
        status: 'SUCCEEDED',
        provider: 'STRIPE',
      },
    });

    for (let i = 0; i < 2; i++) {
      await db.$transaction((tx: DbTransactionClient) =>
        creditFromCancellation(tx, {
          customerId: reservation.customerId,
          reservationId: reservation.id,
          amountCents: 50_000,
          paymentId: payment.id,
        })
      );
    }

    expect(await creditBalance(db, reservation.customerId)).toBe(50_000);
  });
});

describe('refundCredit and adjustCredit', () => {
  it('requires a reason', async () => {
    const customerId = await seedCustomer(db);

    const refund = await refundCredit(db, { customerId, amountCents: 100, reason: '  ', actorId: staffId });
    const adjust = await adjustCredit(db, { customerId, amountCents: 100, reason: '', actorId: staffId });

    expect(refund).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } });
    expect(adjust).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } });
  });

  it('adjusts in either direction and refunds downwards', async () => {
    const customerId = await seedCustomer(db);

    await giveCredit(customerId, 100_000);
    await adjustCredit(db, { customerId, amountCents: -20_000, reason: 'Typo in the opening balance', actorId: staffId });
    await refundCredit(db, { customerId, amountCents: 30_000, reason: 'Returned in cash', actorId: staffId });

    const credit = await listCreditEntries(db, customerId);
    expect(credit.ok && credit.value.balanceCents).toBe(50_000);
    expect(credit.ok && credit.value.entries.map((entry) => [entry.kind, entry.amountCents])).toEqual([
      ['REFUND', -30_000],
      ['ADJUSTMENT', -20_000],
      ['ADJUSTMENT', 100_000],
    ]);
  });

  it('never takes the balance below zero', async () => {
    const customerId = await seedCustomer(db);
    await giveCredit(customerId, 10_000);

    const refund = await refundCredit(db, { customerId, amountCents: 10_001, reason: 'Too much', actorId: staffId });
    const adjust = await adjustCredit(db, { customerId, amountCents: -10_001, reason: 'Too much', actorId: staffId });

    expect(refund).toMatchObject({ ok: false, error: { code: 'CREDIT_INSUFFICIENT', details: { balanceCents: 10_000 } } });
    expect(adjust).toMatchObject({ ok: false, error: { code: 'CREDIT_INSUFFICIENT' } });
    expect(await creditBalance(db, customerId)).toBe(10_000);
  });

  it('refuses a zero adjustment and an unknown customer', async () => {
    const customerId = await seedCustomer(db);

    expect(await adjustCredit(db, { customerId, amountCents: 0, reason: 'x', actorId: staffId })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(
      await adjustCredit(db, {
        customerId: '00000000-0000-4000-8000-000000000000',
        amountCents: 100,
        reason: 'x',
        actorId: staffId,
      })
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('audits every movement with its actor and reason', async () => {
    const customerId = await seedCustomer(db);

    await giveCredit(customerId, 10_000);
    await refundCredit(db, { customerId, amountCents: 4_000, reason: 'Returned in cash', actorId: staffId });

    const audits = await db.auditLog.findMany({
      where: { action: 'credit.entry_created' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      actorUserId: staffId,
      after: expect.objectContaining({ kind: 'REFUND', amountCents: -4_000, reason: 'Returned in cash', balanceCents: 6_000 }),
    });
  });
});

describe('applyCreditToReservation', () => {
  it('pays with credit: a numbered CREDIT payment, paid_cents moved, the hold activated', async () => {
    const reservation = await seedReservation(db, staffId, { minimumDepositCents: 100_000 });
    await giveCredit(reservation.customerId, 150_000);

    const applied = await applyCreditToReservation(db, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      amountCents: 120_000,
      actorId: staffId,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).toMatchObject({ method: 'CREDIT', status: 'SUCCEEDED', provider: 'MANUAL', amountCents: 120_000 });
    expect(applied.value.receiptNumber).toMatch(/^RM-\d{4}-000001$/);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after).toMatchObject({ paidCents: 120_000, status: 'ACTIVE', holdExpiresAt: null });

    const entries = await db.customerCreditEntry.findMany({ where: { kind: 'APPLIED' } });
    expect(entries).toMatchObject([
      { amountCents: -120_000, reservationId: reservation.id, paymentId: applied.value.id, createdById: staffId },
    ]);
    expect(await creditBalance(db, reservation.customerId)).toBe(30_000);

    const jobs = await queue.findJobs(SEND_RECEIPT_JOB, {});
    expect(jobs.map((job) => job.data)).toEqual([{ paymentId: applied.value.id }]);
  });

  it('never applies more than the customer has', async () => {
    const reservation = await seedReservation(db, staffId);
    await giveCredit(reservation.customerId, 10_000);

    const applied = await applyCreditToReservation(db, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      amountCents: 10_001,
      actorId: staffId,
    });

    expect(applied).toMatchObject({ ok: false, error: { code: 'CREDIT_INSUFFICIENT' } });
    expect(await db.payment.count()).toBe(0);
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);
  });

  it('never applies more than the reservation still owes', async () => {
    const reservation = await seedReservation(db, staffId, { totalPriceCents: 500_000, paidCents: 450_000, status: 'ACTIVE' });
    await giveCredit(reservation.customerId, 100_000);

    const applied = await applyCreditToReservation(db, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      amountCents: 60_000,
      actorId: staffId,
    });

    expect(applied).toMatchObject({ ok: false, error: { code: 'PAYMENT_EXCEEDS_BALANCE' } });
    expect(await creditBalance(db, reservation.customerId)).toBe(100_000);
    expect(await db.customerCreditEntry.count({ where: { kind: 'APPLIED' } })).toBe(0);
  });

  it("refuses another customer's reservation and a reservation that is not live", async () => {
    const someoneElse = await seedCustomer(db);
    await giveCredit(someoneElse, 100_000);
    const reservation = await seedReservation(db, staffId);
    const cancelled = await seedReservation(db, staffId, { customerId: someoneElse, status: 'CANCELLED' });

    expect(
      await applyCreditToReservation(db, queue, {
        customerId: someoneElse,
        reservationId: reservation.id,
        amountCents: 1_000,
        actorId: staffId,
      })
    ).toMatchObject({ ok: false, error: { code: 'RESERVATION_NOT_OWNED' } });
    expect(
      await applyCreditToReservation(db, queue, {
        customerId: someoneElse,
        reservationId: cancelled.id,
        amountCents: 1_000,
        actorId: staffId,
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
  });

  it('lets only one of two simultaneous applications spend the same credit', async () => {
    const customerId = await seedCustomer(db);
    await giveCredit(customerId, 150_000);
    const first = await seedReservation(db, staffId, { customerId });
    const second = await seedReservation(db, staffId, { customerId });

    const results = await Promise.all(
      [first, second].map((reservation) =>
        applyCreditToReservation(db, queue, { customerId, reservationId: reservation.id, amountCents: 100_000, actorId: staffId })
      )
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: 'CREDIT_INSUFFICIENT' } });
    expect(await creditBalance(db, customerId)).toBe(50_000);
  });

  it('leaves paid_cents equal to the sum of SUCCEEDED payments', async () => {
    const reservation = await seedReservation(db, staffId);
    await giveCredit(reservation.customerId, 80_000);

    await applyCreditToReservation(db, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      amountCents: 80_000,
      actorId: staffId,
    });

    const drift = await db.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM reservations r
      WHERE r.paid_cents <> COALESCE(
        (SELECT SUM(p.amount_cents) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'SUCCEEDED'), 0)
    `;
    expect(drift).toEqual([]);
  });
});

describe('addCreditEntry', () => {
  it('keeps the database CHECK out of reach: zero is refused before the insert', async () => {
    const customerId = await seedCustomer(db);

    const result = await db.$transaction((tx: DbTransactionClient) =>
      addCreditEntry(tx, { customerId, amountCents: 0, kind: 'ADJUSTMENT' })
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
});
