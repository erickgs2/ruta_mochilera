import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { GET as pendingRoute } from './route';

const db = withTestDb();

function request(url: string, token?: string) {
  return new Request(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
const noParams = { params: Promise.resolve({}) };

async function seedPendingVoucher(overrides: { code: string; method?: 'OXXO' | 'SPEI' | 'CARD'; voucherExpiresAt?: Date | null }) {
  const creator = await db.user.upsert({
    where: { email: 'creator@agency.test' },
    create: { email: 'creator@agency.test', type: 'STAFF' },
    update: {},
  });
  const customer = await db.user.create({
    data: {
      email: `${overrides.code.toLowerCase()}@customer.test`,
      type: 'CUSTOMER',
      customerProfile: { create: { fullName: 'Ana Pérez', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' } },
    },
  });
  const trip = await db.trip.create({
    data: {
      slug: `trip-${overrides.code.toLowerCase()}`,
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
  const reservation = await db.reservation.create({
    data: {
      code: overrides.code,
      tripId: trip.id,
      customerId: customer.id,
      status: 'HELD',
      holdExpiresAt: new Date('2028-01-01'),
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
  return db.payment.create({
    data: {
      reservationId: reservation.id,
      amountCents: 100_000,
      method: overrides.method ?? 'OXXO',
      status: 'PENDING',
      provider: 'STRIPE',
      voucherExpiresAt: overrides.voucherExpiresAt === undefined ? new Date('2028-01-01T00:00:00Z') : overrides.voucherExpiresAt,
    },
  });
}

describe('GET /api/v1/admin/payments (pending vouchers)', () => {
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

  it('answers 401 without a token', async () => {
    expect((await pendingRoute(request('/api/v1/admin/payments?status=PENDING'), noParams)).status).toBe(401);
  });

  it('answers 403 PERMISSION_DENIED to staff without payment.view', async () => {
    const token = await loginAs(db, 'reservations@agency.test', ['reservation.view', 'customer.view']);
    const response = await pendingRoute(request('/api/v1/admin/payments?status=PENDING', token), noParams);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('PERMISSION_DENIED');
  });

  it('answers 403 to a customer', async () => {
    const { token } = await loginAsCustomer(db, 'customer@example.com');
    expect((await pendingRoute(request('/api/v1/admin/payments?status=PENDING', token), noParams)).status).toBe(403);
  });

  it('lists the pending OXXO and SPEI vouchers, soonest expiry first, and leaves card intents out', async () => {
    const later = await seedPendingVoucher({ code: 'RM-LATER', voucherExpiresAt: new Date('2028-01-05T00:00:00Z') });
    const sooner = await seedPendingVoucher({ code: 'RM-SOONER', voucherExpiresAt: new Date('2028-01-02T00:00:00Z') });
    const spei = await seedPendingVoucher({ code: 'RM-SPEI', method: 'SPEI', voucherExpiresAt: null });
    await seedPendingVoucher({ code: 'RM-CARD', method: 'CARD' });
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

    const response = await pendingRoute(request('/api/v1/admin/payments?status=PENDING', token), noParams);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([sooner.id, later.id, spei.id]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      reservationCode: 'RM-SOONER',
      customerName: 'Ana Pérez',
      tripName: 'trip-rm-sooner',
      amountCents: 100_000,
      method: 'OXXO',
      status: 'PENDING',
      voucherExpiresAt: '2028-01-02T00:00:00.000Z',
    });
    expect(typeof body.items[0].createdAt).toBe('string');
  });

  it('defaults to PENDING when status is omitted, and narrows by method', async () => {
    await seedPendingVoucher({ code: 'RM-OXXO' });
    const spei = await seedPendingVoucher({ code: 'RM-SPEI', method: 'SPEI', voucherExpiresAt: null });
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

    const response = await pendingRoute(request('/api/v1/admin/payments?method=SPEI', token), noParams);

    expect(response.status).toBe(200);
    expect((await response.json()).items.map((row: { id: string }) => row.id)).toEqual([spei.id]);
  });

  it('pages with nextCursor until the list is exhausted', async () => {
    for (const day of ['02', '03', '04']) {
      await seedPendingVoucher({ code: `RM-D${day}`, voucherExpiresAt: new Date(`2028-01-${day}T00:00:00Z`) });
    }
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

    const first = await (await pendingRoute(request('/api/v1/admin/payments?limit=2', token), noParams)).json();
    expect(first.items.map((row: { reservationCode: string }) => row.reservationCode)).toEqual(['RM-D02', 'RM-D03']);
    expect(typeof first.nextCursor).toBe('string');

    const second = await (
      await pendingRoute(request(`/api/v1/admin/payments?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, token), noParams)
    ).json();
    expect(second.items.map((row: { reservationCode: string }) => row.reservationCode)).toEqual(['RM-D04']);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['a card method', 'method=CARD'],
    ['a status other than PENDING', 'status=SUCCEEDED'],
    ['a zero limit', 'limit=0'],
    ['a non-numeric limit', 'limit=abc'],
    ['a malformed cursor', 'cursor=not-a-cursor'],
  ])('answers 422 VALIDATION_FAILED for %s', async (_label, query) => {
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);
    const response = await pendingRoute(request(`/api/v1/admin/payments?${query}`, token), noParams);
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });
});
