import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { GET as myCreditRoute } from '../../me/credit/route';
import { POST as applyCreditRoute } from '../reservations/[reservationId]/apply-credit/route';
import { POST as adjustRoute } from './[customerId]/credit/adjust/route';
import { POST as refundRoute } from './[customerId]/credit/refund/route';
import { GET as creditRoute } from './[customerId]/credit/route';

const db = withTestDb();

function request(url: string, token: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${token}`,
    },
  });
}

const customerParams = (customerId: string) => ({ params: Promise.resolve({ customerId }) });
const reservationParams = (reservationId: string) => ({ params: Promise.resolve({ reservationId }) });

async function seedHeldReservation(customerId: string) {
  const creator = await db.user.create({ data: { email: 'creator@agency.test', type: 'STAFF' } });
  const trip = await db.trip.create({
    data: {
      slug: 'credit-trip',
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: creator.id,
    },
  });
  return db.reservation.create({
    data: {
      code: 'RM-CREDIT-1',
      tripId: trip.id,
      customerId,
      status: 'HELD',
      holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

describe('customer credit endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('adjusts, refunds and lists, with payment.credit.apply and payment.view', async () => {
    const { userId: customerId } = await loginAsCustomer(db, 'traveler@example.com');
    const token = await loginAs(db, 'cashier@agency.test', ['payment.credit.apply', 'payment.view']);

    const adjusted = await adjustRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/adjust`, token, { amountCents: 100_000, reason: 'Cortesía' }),
      customerParams(customerId)
    );
    expect(adjusted.status).toBe(201);
    const refunded = await refundRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/refund`, token, { amountCents: 40_000, reason: 'Efectivo' }),
      customerParams(customerId)
    );
    expect(refunded.status).toBe(201);

    const listed = await creditRoute(request(`/api/v1/admin/customers/${customerId}/credit`, token), customerParams(customerId));
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.balanceCents).toBe(60_000);
    expect(body.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['REFUND', 'ADJUSTMENT']);
  });

  it('answers 409 CREDIT_INSUFFICIENT for a refund larger than the balance', async () => {
    const { userId: customerId } = await loginAsCustomer(db, 'traveler@example.com');
    const token = await loginAs(db, 'cashier@agency.test', ['payment.credit.apply']);

    const response = await refundRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/refund`, token, { amountCents: 1, reason: 'x' }),
      customerParams(customerId)
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CREDIT_INSUFFICIENT');
  });

  it('refuses a movement without a reason (422) and without the permission (403)', async () => {
    const { userId: customerId } = await loginAsCustomer(db, 'traveler@example.com');
    const viewer = await loginAs(db, 'viewer@agency.test', ['payment.view']);
    const cashier = await loginAs(db, 'cashier@agency.test', ['payment.credit.apply']);

    const forbidden = await adjustRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/adjust`, viewer, { amountCents: 100, reason: 'x' }),
      customerParams(customerId)
    );
    const noReason = await adjustRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/adjust`, cashier, { amountCents: 100, reason: ' ' }),
      customerParams(customerId)
    );

    expect(forbidden.status).toBe(403);
    expect(noReason.status).toBe(422);
    expect(await db.customerCreditEntry.count()).toBe(0);
  });

  it('applies credit to a reservation: 201 with a numbered CREDIT payment', async () => {
    const { userId: customerId } = await loginAsCustomer(db, 'traveler@example.com');
    const reservation = await seedHeldReservation(customerId);
    const token = await loginAs(db, 'cashier@agency.test', ['payment.credit.apply']);
    await adjustRoute(
      request(`/api/v1/admin/customers/${customerId}/credit/adjust`, token, { amountCents: 100_000, reason: 'Saldo' }),
      customerParams(customerId)
    );

    const response = await applyCreditRoute(
      request(`/api/v1/admin/reservations/${reservation.id}/apply-credit`, token, { amountCents: 100_000 }),
      reservationParams(reservation.id)
    );

    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment).toMatchObject({ method: 'CREDIT', status: 'SUCCEEDED', amountCents: 100_000 });
    expect(payment.receiptNumber).toMatch(/^RM-\d{4}-000001$/);
    const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(stored.status).toBe('ACTIVE');
  });

  it('shows the customer their own credit, read-only', async () => {
    const { userId: customerId, token } = await loginAsCustomer(db, 'traveler@example.com');
    await db.customerCreditEntry.create({
      data: { customerId, amountCents: 25_000, kind: 'CANCELLATION' },
    });

    const response = await myCreditRoute(request('/api/v1/me/credit', token), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    expect((await response.json()).balanceCents).toBe(25_000);
  });
});
