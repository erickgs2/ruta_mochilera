import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { loginAs, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../lib/queue';
import { POST as cashRoute } from './[reservationId]/payments/route';
import { POST as createRoute } from './route';

const db = withTestDb();

function post(url: string, token: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}
const noParams = { params: Promise.resolve({}) };

async function seedTripAndCustomer(totalCapacity = 20) {
  const creator = await db.user.create({ data: { email: 'creator@agency.test', type: 'STAFF' } });
  const trip = await db.trip.create({
    data: {
      slug: `counter-trip-${totalCapacity}`,
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: creator.id,
    },
  });
  const customer = await db.user.create({
    data: {
      email: 'maria@example.com',
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: { fullName: 'María Peña', phone: '3521008079', birthDate: new Date('1990-05-17'), origin: 'BRANCH' },
      },
    },
  });
  return { trip, customerId: customer.id };
}

describe('counter reservations and cash', () => {
  let queue: PgBoss;

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
  });
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('reserves with a payment that covers the deposit: ACTIVE, numbered cash, receipt queued', async () => {
    const { trip, customerId } = await seedTripAndCustomer();
    const token = await loginAs(db, 'desk@agency.test', ['reservation.create', 'payment.register']);

    const response = await createRoute(
      post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId, initialPaymentCents: 150_000 }),
      noParams
    );

    expect(response.status).toBe(201);
    const reservation = await response.json();
    expect(reservation).toMatchObject({ status: 'ACTIVE', holdExpiresAt: null, paidCents: 150_000 });
    const payments = await db.payment.findMany({ where: { reservationId: reservation.id } });
    expect(payments).toMatchObject([{ method: 'CASH', status: 'SUCCEEDED', amountCents: 150_000 }]);
    expect(payments[0]?.receiptNumber).toMatch(/^RM-\d{4}-000001$/);
    expect((await queue.findJobs(SEND_RECEIPT_JOB, {})).map((job) => job.data)).toEqual([{ paymentId: payments[0]?.id }]);
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).source).toBe('BRANCH');
  });

  it('reserves with a smaller payment: HELD with the trip hold and the payment recorded', async () => {
    const { trip, customerId } = await seedTripAndCustomer();
    const token = await loginAs(db, 'desk@agency.test', ['reservation.create', 'payment.register']);

    const response = await createRoute(
      post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId, initialPaymentCents: 50_000 }),
      noParams
    );

    expect(response.status).toBe(201);
    const reservation = await response.json();
    expect(reservation).toMatchObject({ status: 'HELD', paidCents: 50_000 });
    expect(reservation.holdExpiresAt).not.toBeNull();
  });

  it('holds without payment, and leaves nothing behind when the trip is sold out', async () => {
    const { trip, customerId } = await seedTripAndCustomer(1);
    const token = await loginAs(db, 'desk@agency.test', ['reservation.create', 'payment.register']);
    const other = await db.user.create({
      data: {
        email: 'other@example.com',
        type: 'CUSTOMER',
        emailVerifiedAt: new Date(),
        customerProfile: { create: { fullName: 'Otro', phone: '1234567', birthDate: new Date('1990-01-01'), origin: 'BRANCH' } },
      },
    });

    const held = await createRoute(post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId }), noParams);
    expect(held.status).toBe(201);
    expect((await held.json()).status).toBe('HELD');

    const soldOut = await createRoute(
      post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId: other.id, initialPaymentCents: 100_000 }),
      noParams
    );
    expect(soldOut.status).toBe(409);
    expect((await soldOut.json()).code).toBe('TRIP_SOLD_OUT');
    expect(await db.reservation.count()).toBe(1);
    expect(await db.payment.count()).toBe(0);
  });

  it('requires payment.register on top of reservation.create when there is a payment', async () => {
    const { trip, customerId } = await seedTripAndCustomer();
    const token = await loginAs(db, 'desk@agency.test', ['reservation.create']);

    const withPayment = await createRoute(
      post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId, initialPaymentCents: 50_000 }),
      noParams
    );
    expect(withPayment.status).toBe(403);
    expect(await db.reservation.count()).toBe(0);

    const without = await createRoute(post('/api/v1/admin/reservations', token, { tripId: trip.id, customerId }), noParams);
    expect(without.status).toBe(201);
  });

  it('takes cash for an existing reservation with payment.register', async () => {
    const { trip, customerId } = await seedTripAndCustomer();
    const desk = await loginAs(db, 'desk@agency.test', ['reservation.create']);
    const cashier = await loginAs(db, 'cashier@agency.test', ['payment.register']);
    const reservation = await (await createRoute(post('/api/v1/admin/reservations', desk, { tripId: trip.id, customerId }), noParams)).json();

    const forbidden = await cashRoute(
      post(`/api/v1/admin/reservations/${reservation.id}/payments`, desk, { amountCents: 100_000 }),
      { params: Promise.resolve({ reservationId: reservation.id }) }
    );
    expect(forbidden.status).toBe(403);

    const paid = await cashRoute(
      post(`/api/v1/admin/reservations/${reservation.id}/payments`, cashier, { amountCents: 100_000 }),
      { params: Promise.resolve({ reservationId: reservation.id }) }
    );
    expect(paid.status).toBe(201);
    expect(await paid.json()).toMatchObject({ method: 'CASH', amountCents: 100_000 });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('ACTIVE');
  });
});
