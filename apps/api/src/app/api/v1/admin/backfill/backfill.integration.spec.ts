import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { TripStatus } from '@rm/db';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { loginAs, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../lib/queue';
import { POST as paymentsRoute } from './payments/route';
import { POST as reservationsRoute } from './reservations/route';

const db = withTestDb();
const noParams = { params: Promise.resolve({}) };

function post(url: string, token: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

let sequence = 0;
async function seedTrip(status: TripStatus, totalCapacity = 20) {
  sequence += 1;
  const creator = await db.user.create({ data: { email: `creator${sequence}@agency.test`, type: 'STAFF' } });
  return db.trip.create({
    data: {
      slug: `history-${sequence}`,
      status,
      departureDate: new Date('2026-03-01'),
      returnDate: new Date('2026-03-07'),
      paymentDeadline: new Date('2026-02-01'),
      totalCapacity,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: creator.id,
    },
  });
}

async function seedCustomer() {
  sequence += 1;
  const customer = await db.user.create({
    data: {
      email: `history${sequence}@example.com`,
      type: 'CUSTOMER',
      customerProfile: { create: { fullName: 'Cliente', phone: '3521008079', birthDate: new Date('1990-05-17'), origin: 'IMPORT' } },
    },
  });
  return customer.id;
}

describe('historical capture', () => {
  let queue: PgBoss;
  let token: string;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    queue = await withTestQueue();
    setQueue(queue);
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
    token = await loginAs(db, 'admin@agency.test', ['data.backfill']);
  });
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('captures a reservation on a finished trip: past created_at, backfilled, ACTIVE with no hold, counting for capacity', async () => {
    const trip = await seedTrip('COMPLETED', 1);
    const customerId = await seedCustomer();

    const response = await reservationsRoute(
      post('/api/v1/admin/backfill/reservations', token, {
        tripId: trip.id,
        customerId,
        createdAt: '2025-11-03T17:00:00.000Z',
        totalPriceCents: 450_000,
      }),
      noParams
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    const stored = await db.reservation.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      holdExpiresAt: null,
      isBackfilled: true,
      source: 'BRANCH',
      totalPriceCents: 450_000,
      createdAt: new Date('2025-11-03T17:00:00.000Z'),
    });
    const audit = await db.auditLog.findFirst({ where: { action: 'reservation.backfilled', entityId: stored.id } });
    expect(audit).not.toBeNull();

    // The one seat is now taken.
    const second = await reservationsRoute(
      post('/api/v1/admin/backfill/reservations', token, { tripId: trip.id, customerId: await seedCustomer(), createdAt: '2025-11-04T17:00:00.000Z' }),
      noParams
    );
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('TRIP_SOLD_OUT');
  });

  it('refuses a DRAFT or CANCELLED trip', async () => {
    for (const status of ['DRAFT', 'CANCELLED'] as const) {
      const trip = await seedTrip(status);
      const response = await reservationsRoute(
        post('/api/v1/admin/backfill/reservations', token, { tripId: trip.id, customerId: await seedCustomer(), createdAt: '2025-11-03T17:00:00.000Z' }),
        noParams
      );
      expect(response.status).toBe(409);
    }
    expect(await db.reservation.count()).toBe(0);
  });

  it('records the payments with past paid_at, backfilled, numbered in their own year, without receipts by default', async () => {
    const trip = await seedTrip('IN_PROGRESS');
    const customerId = await seedCustomer();

    const response = await reservationsRoute(
      post('/api/v1/admin/backfill/reservations', token, {
        tripId: trip.id,
        customerId,
        createdAt: '2025-11-03T17:00:00.000Z',
        payments: [
          { amountCents: 200_000, paidAt: '2026-01-15T17:00:00.000Z', method: 'CASH' },
          { amountCents: 100_000, paidAt: '2025-11-03T17:00:00.000Z' },
        ],
      }),
      noParams
    );

    expect(response.status).toBe(201);
    const reservation = await response.json();
    expect(reservation.paidCents).toBe(300_000);
    const payments = await db.payment.findMany({ where: { reservationId: reservation.id }, orderBy: { paidAt: 'asc' } });
    expect(payments).toMatchObject([
      { amountCents: 100_000, method: 'LEGACY', isBackfilled: true, receiptNumber: 'RM-2025-000001', receiptPaidCents: 100_000 },
      { amountCents: 200_000, method: 'CASH', isBackfilled: true, receiptNumber: 'RM-2026-000001', receiptPaidCents: 300_000 },
    ]);
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);
  });

  it('queues receipts when staff tick the box, and adds history to an existing reservation all or nothing', async () => {
    const trip = await seedTrip('PUBLISHED');
    const customerId = await seedCustomer();
    const reservation = await (
      await reservationsRoute(
        post('/api/v1/admin/backfill/reservations', token, { tripId: trip.id, customerId, createdAt: '2025-11-03T17:00:00.000Z' }),
        noParams
      )
    ).json();

    const tooMuch = await paymentsRoute(
      post('/api/v1/admin/backfill/payments', token, {
        reservationId: reservation.id,
        payments: [
          { amountCents: 300_000, paidAt: '2025-12-01T17:00:00.000Z' },
          { amountCents: 300_000, paidAt: '2025-12-02T17:00:00.000Z' },
        ],
      }),
      noParams
    );
    expect(tooMuch.status).toBe(422);
    expect(await db.payment.count()).toBe(0);

    const ok = await paymentsRoute(
      post('/api/v1/admin/backfill/payments', token, {
        reservationId: reservation.id,
        payments: [{ amountCents: 300_000, paidAt: '2025-12-01T17:00:00.000Z' }],
        sendReceipts: true,
      }),
      noParams
    );
    expect(ok.status).toBe(201);
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toHaveLength(1);
  });

  it('requires data.backfill', async () => {
    const trip = await seedTrip('COMPLETED');
    const other = await loginAs(db, 'desk@agency.test', ['reservation.create', 'payment.register']);

    const response = await reservationsRoute(
      post('/api/v1/admin/backfill/reservations', other, { tripId: trip.id, customerId: await seedCustomer(), createdAt: '2025-11-03T17:00:00.000Z' }),
      noParams
    );

    expect(response.status).toBe(403);
  });
});
