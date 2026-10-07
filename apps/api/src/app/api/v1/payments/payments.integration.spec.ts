import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAsCustomer } from '../../../../test-support/auth-fixtures';
import { GET as listPaymentsRoute } from './route';

const db = withTestDb();
let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

function request(url: string, token?: string) {
  return new Request(`http://localhost${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function seedPaidReservation(customerId: string) {
  const index = next();
  const staff = await db.user.create({
    data: { email: `staff-${index}@agency.test`, type: 'STAFF', staffProfile: { create: { fullName: 'Staff' } } },
  });
  const trip = await db.trip.create({
    data: {
      slug: `trip-pay-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staff.id,
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: `RM-PAY${index}`,
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
  await db.payment.create({
    data: {
      reservationId: reservation.id,
      amountCents: 150_000,
      method: 'CARD',
      status: 'SUCCEEDED',
      provider: 'STRIPE',
      paidAt: new Date(),
    },
  });
}

describe('GET /api/v1/payments', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  it('lists only the authenticated customer\'s own payments', async () => {
    const ana = await loginAsCustomer(db, 'ana-pay@agency.test');
    const beto = await loginAsCustomer(db, 'beto-pay@agency.test');
    await seedPaidReservation(ana.userId);
    await seedPaidReservation(beto.userId);

    const response = await listPaymentsRoute(request('/api/v1/payments', ana.token));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { amountCents: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.amountCents).toBe(150_000);
  });

  it('returns 401 for an unauthenticated caller', async () => {
    const response = await listPaymentsRoute(request('/api/v1/payments'));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('TOKEN_INVALID');
  });
});
