import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import type { DbTransactionClient } from '@rm/db';
import { createBackfilledPaymentsHook, recordBackfilledPayments } from './backfill';
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

describe('recordBackfilledPayments with calendar dates (the rule lives in the domain)', () => {
  const run = (reservationId: string, paidAt: Date | string, extra: Partial<{ amountCents: number }> = {}) =>
    recordBackfilledPayments(db, queue, {
      reservationId,
      actorId: staffId,
      payments: [{ amountCents: extra.amountCents ?? 100, paidAt, method: 'LEGACY' }],
      sendReceipts: false,
    });

  it('stamps a YYYY-MM-DD at noon in the organization zone', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });

    const result = await run(reservation.id, '2025-11-03');

    expect(result.ok).toBe(true);
    expect((await db.payment.findFirstOrThrow()).paidAt!.toISOString()).toBe('2025-11-03T18:00:00.000Z');
  });

  it("reads the day in the organization's zone, not the browser's or the server's", async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });
    await db.systemSetting.upsert({
      where: { key: 'organization.timezone' },
      update: { value: 'Pacific/Auckland' },
      create: { key: 'organization.timezone', value: 'Pacific/Auckland' },
    });

    await run(reservation.id, '2025-11-03');

    expect((await db.payment.findFirstOrThrow()).paidAt!.toISOString()).toBe('2025-11-02T23:00:00.000Z');
  });

  it('never stamps a payment in the future: a date of today, captured before noon, is capped at the moment of capture', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });
    // 09:00 on 7 October in Mexico City, fixed: the cap only shows before
    // local noon, so the test must not depend on the hour it runs at.
    const now = new Date('2026-10-07T15:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      const result = await run(reservation.id, '2026-10-07');

      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect((await db.payment.findFirstOrThrow()).paidAt!.toISOString()).toBe(now.toISOString());
  });

  it('stamps a date of today at noon once noon has passed', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-07T23:00:00Z') }); // 17:00 in Mexico City
    try {
      await run(reservation.id, '2026-10-07');
    } finally {
      vi.useRealTimers();
    }
    expect((await db.payment.findFirstOrThrow()).paidAt!.toISOString()).toBe('2026-10-07T18:00:00.000Z');
  });

  it('refuses a date after today, and text that is not a date, writing nothing', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });

    for (const paidAt of ['2999-01-01', '2026-02-31', 'ayer']) {
      expect(await run(reservation.id, paidAt)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { field: 'payments.0.paidAt' } },
      });
    }
    expect(await db.payment.count()).toBe(0);
  });

  it('applies the same rule to the hook a reservation capture injects, rolling the transaction back', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE' });
    const hook = createBackfilledPaymentsHook(queue, [{ amountCents: 100, paidAt: '2999-01-01', method: 'LEGACY' }], false);

    const refused = await db.$transaction((tx: DbTransactionClient) => hook(tx, { reservationId: reservation.id, actorId: staffId }));
    const accepted = await db.$transaction((tx: DbTransactionClient) =>
      createBackfilledPaymentsHook(queue, [{ amountCents: 100, paidAt: '2025-11-03', method: 'LEGACY' }], false)(tx, {
        reservationId: reservation.id,
        actorId: staffId,
      })
    );

    expect(refused).toMatchObject({ ok: false, error: { details: { field: 'payments.0.paidAt' } } });
    expect(accepted.ok).toBe(true);
    expect(await db.payment.count()).toBe(1);
  });
});
