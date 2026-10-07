import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { loginAs, seedPermissionCatalog } from '../../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../../lib/queue';
import { GET as previewRoute, POST as applyRoute } from './route';

const db = withTestDb();

function request(url: string, token: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
  });
}

async function seed() {
  const creator = await db.user.create({ data: { email: 'creator@agency.test', type: 'STAFF' } });
  const trip = await db.trip.create({
    data: {
      slug: 'price-trip',
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 400_000,
      createdById: creator.id,
    },
  });
  const customer = await db.user.create({
    data: {
      email: 'maria@example.com',
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: { create: { fullName: 'María', phone: '3521008079', birthDate: new Date('1990-05-17'), origin: 'BRANCH' } },
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: 'RM-PRICE',
      tripId: trip.id,
      customerId: customer.id,
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: 450_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'BRANCH',
    },
  });
  await db.payment.create({
    data: { reservationId: reservation.id, amountCents: 450_000, method: 'CASH', status: 'SUCCEEDED', provider: 'MANUAL' },
  });
  return { trip, reservation };
}

describe('price change endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    setQueue(await withTestQueue());
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

  it('previews and applies with trip.change_price, crediting what was paid above the new total', async () => {
    const { trip, reservation } = await seed();
    const token = await loginAs(db, 'admin@agency.test', ['trip.change_price']);
    const params = { params: Promise.resolve({ tripId: trip.id }) };

    const preview = await previewRoute(request(`/api/v1/trips/${trip.id}/price-change`, token), params);
    expect(preview.status).toBe(200);
    expect((await preview.json()).reservations).toMatchObject([{ reservationId: reservation.id, creditCents: 50_000 }]);

    const applied = await applyRoute(request(`/api/v1/trips/${trip.id}/price-change`, token, { noticeEs: 'Bajó el precio.' }), params);
    expect(applied.status).toBe(200);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      totalPriceCents: 400_000,
      paidCents: 400_000,
    });
    expect(await db.customerCreditEntry.findMany()).toMatchObject([{ kind: 'PRICE_DECREASE', amountCents: 50_000 }]);

    const again = await previewRoute(request(`/api/v1/trips/${trip.id}/price-change`, token), params);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('NO_PRICE_CHANGE');
  });

  it('requires trip.change_price and the Spanish notice', async () => {
    const { trip } = await seed();
    const editor = await loginAs(db, 'editor@agency.test', ['trip.update']);
    const admin = await loginAs(db, 'admin@agency.test', ['trip.change_price']);
    const params = { params: Promise.resolve({ tripId: trip.id }) };

    expect((await previewRoute(request(`/api/v1/trips/${trip.id}/price-change`, editor), params)).status).toBe(403);
    expect((await applyRoute(request(`/api/v1/trips/${trip.id}/price-change`, admin, { noticeEs: '' }), params)).status).toBe(422);
  });
});
