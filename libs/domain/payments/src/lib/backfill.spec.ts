import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { recordBackfilledPayments } from './backfill';
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

describe('recordBackfilledPayments', () => {
  it('refuses a payment dated in the future and an empty list', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });

    const future = await recordBackfilledPayments(db, queue, {
      reservationId: reservation.id,
      actorId: staffId,
      payments: [{ amountCents: 100, paidAt: new Date(Date.now() + 86_400_000), method: 'LEGACY' }],
      sendReceipts: false,
    });
    const empty = await recordBackfilledPayments(db, queue, {
      reservationId: reservation.id,
      actorId: staffId,
      payments: [],
      sendReceipts: false,
    });

    expect(future).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'payments.0.paidAt' } } });
    expect(empty).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses a reservation that is not live', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'CANCELLED' });

    const result = await recordBackfilledPayments(db, queue, {
      reservationId: reservation.id,
      actorId: staffId,
      payments: [{ amountCents: 100, paidAt: new Date('2025-01-01T12:00:00Z'), method: 'LEGACY' }],
      sendReceipts: false,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
  });

  it('records the staff member and the notes on each payment', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });

    await recordBackfilledPayments(db, queue, {
      reservationId: reservation.id,
      actorId: staffId,
      payments: [{ amountCents: 100, paidAt: new Date('2025-01-01T12:00:00Z'), method: 'LEGACY', notes: 'Libreta 3, hoja 12' }],
      sendReceipts: false,
    });

    expect(await db.payment.findFirstOrThrow()).toMatchObject({ recordedById: staffId, notes: 'Libreta 3, hoja 12', isBackfilled: true });
  });
});
