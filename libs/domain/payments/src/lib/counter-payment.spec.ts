import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { registerCashPayment } from './counter-payment';
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
