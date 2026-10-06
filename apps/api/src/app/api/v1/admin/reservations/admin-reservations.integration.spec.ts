import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { FakePaymentProvider } from '@rm/payments-stripe';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setPaymentProvider } from '../../../../../lib/payment-provider';
import { setQueue } from '../../../../../lib/queue';
import { POST as cancelRoute } from './[reservationId]/cancel/route';
import { GET as listPaymentsRoute } from './[reservationId]/payments/route';
import { GET as detailRoute } from './[reservationId]/route';
import { GET as listRoute } from './route';

const db = withTestDb();

let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

function withId(reservationId: string) {
  return { params: Promise.resolve({ reservationId }) };
}

function request(url: string, token?: string, init: RequestInit = {}) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function cancel(reservationId: string, token: string, reason = 'Solicitud del cliente') {
  return cancelRoute(
    request(`/api/v1/admin/reservations/${reservationId}/cancel`, token, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
    withId(reservationId)
  );
}

async function seedTrip(totalCapacity = 20) {
  const index = next();
  const staff = await db.user.create({
    data: { email: `creator-${index}@agency.test`, type: 'STAFF', staffProfile: { create: { fullName: 'Creator' } } },
  });
  return db.trip.create({
    data: {
      slug: `trip-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staff.id,
      translations: {
        create: [{ locale: 'es', name: `Viaje ${index}`, description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' }],
      },
    },
  });
}

/** A HELD reservation written directly, for a fresh customer -- the creation path has its own suite. */
async function seedReservation(tripId: string, overrides: { cancellationRequestedAt?: Date } = {}) {
  const index = next();
  const customer = await db.user.create({
    data: {
      email: `customer-${index}@agency.test`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: { fullName: `Cliente ${index}`, phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
      },
    },
  });
  return db.reservation.create({
    data: {
      code: `RM-TEST-${String(index).padStart(4, '0')}`,
      tripId,
      customerId: customer.id,
      status: 'HELD',
      holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: new Date('2028-02-01'),
      source: 'APP',
      cancellationRequestedAt: overrides.cancellationRequestedAt ?? null,
      cancellationReason: overrides.cancellationRequestedAt ? 'Me enfermé' : null,
    },
  });
}

describe('admin reservation endpoints', () => {
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    setQueue(await withTestQueue());
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
    provider = new FakePaymentProvider();
    setPaymentProvider(provider);
  });
  afterEach(() => setPaymentProvider(undefined));
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  describe('POST /api/v1/admin/reservations/{id}/cancel', () => {
    it('returns 403 PERMISSION_DENIED without reservation.cancel, and changes nothing', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      const response = await cancel(reservation.id, token);

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe('HELD');
    });

    it('cancels with reservation.cancel: 200, the seat is released and the money is kept', async () => {
      const trip = await seedTrip(1);
      const reservation = await seedReservation(trip.id);
      await db.reservation.update({ where: { id: reservation.id }, data: { paidCents: 50_000 } });
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const response = await cancel(reservation.id, token, 'Viaje reprogramado');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('CANCELLED');
      expect(body.paidCents).toBe(50_000);
      expect(body.cancelledByName).toBe('agent@agency.test');
      const committed = await db.reservation.count({ where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } } });
      expect(committed).toBe(0);
    });

    it('cancels the pending payment intents at the provider', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const intent = await provider.createIntent({
        reservationId: reservation.id,
        amountCents: 100_000,
        method: 'OXXO',
        customerEmail: 'traveler@example.com',
        voucherExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      expect(intent.ok).toBe(true);
      if (!intent.ok) return;
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 100_000,
          method: 'OXXO',
          status: 'PENDING',
          provider: 'STRIPE',
          providerIntentId: intent.value.providerIntentId,
        },
      });
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const response = await cancel(reservation.id, token);

      expect(response.status).toBe(200);
      expect(provider.inspect(intent.value.providerIntentId)).toEqual({ status: 'canceled' });
    });

    it('answers a second cancellation with 200 and the same reservation, without a second notice', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const first = await cancel(reservation.id, token);
      const second = await cancel(reservation.id, token);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await second.json()).cancelledAt).toBe((await first.json()).cancelledAt);
      const notices = await db.notificationDelivery.count({
        where: { reservationId: reservation.id, eventType: 'RESERVATION_CANCELLED' },
      });
      expect(notices).toBe(2);
    });

    it('returns 409 INVALID_STATUS_TRANSITION for an EXPIRED reservation', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      await db.reservation.update({ where: { id: reservation.id }, data: { status: 'EXPIRED' } });
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const response = await cancel(reservation.id, token);

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('returns 404 NOT_FOUND for an unknown reservation', async () => {
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const response = await cancel('00000000-0000-4000-8000-000000000000', token);

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });

    it('requires a reason', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const token = await loginAs(db, 'agent@agency.test', ['reservation.cancel']);

      const response = await cancel(reservation.id, token, '   ');

      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it('is out of reach of a CUSTOMER even if a role granted them reservation.cancel', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const { userId, token } = await loginAsCustomer(db, 'sneaky@agency.test');
      const role = await db.role.create({ data: { name: 'smuggled', description: 'x' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { key: 'reservation.cancel' } });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
      await db.userRole.create({ data: { userId, roleId: role.id } });

      const response = await cancel(reservation.id, token);

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe('HELD');
    });

    it('returns 401 without a token', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);

      const response = await cancelRoute(
        request(`/api/v1/admin/reservations/${reservation.id}/cancel`, undefined, {
          method: 'POST',
          body: JSON.stringify({ reason: 'x' }),
        }),
        withId(reservation.id)
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/reservations', () => {
    it('requires reservation.view', async () => {
      const token = await loginAs(db, 'nobody@agency.test', ['trip.view']);

      const response = await listRoute(request('/api/v1/admin/reservations', token));

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('is out of reach of a CUSTOMER', async () => {
      const { token } = await loginAsCustomer(db, 'customer@agency.test');

      const response = await listRoute(request('/api/v1/admin/reservations', token));

      expect(response.status).toBe(403);
    });

    it('lists unresolved cancellation requests first and flags them', async () => {
      const trip = await seedTrip();
      const plain = await seedReservation(trip.id);
      const requested = await seedReservation(trip.id, { cancellationRequestedAt: new Date() });
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      const response = await listRoute(request('/api/v1/admin/reservations', token));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.map((row: { id: string }) => row.id)).toEqual([requested.id, plain.id]);
      expect(body[0].cancellationPending).toBe(true);
      expect(body[0].customerName).toMatch(/^Cliente /);
      expect(body[1].cancellationPending).toBe(false);
    });

    it('filters by trip, by status and by pending request', async () => {
      const tripA = await seedTrip();
      const tripB = await seedTrip();
      const inA = await seedReservation(tripA.id);
      const inB = await seedReservation(tripB.id, { cancellationRequestedAt: new Date() });
      await db.reservation.update({ where: { id: inA.id }, data: { status: 'ACTIVE', holdExpiresAt: null } });
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      const ids = async (query: string) =>
        ((await (await listRoute(request(`/api/v1/admin/reservations${query}`, token))).json()) as { id: string }[]).map(
          (row) => row.id
        );

      expect(await ids(`?tripId=${tripA.id}`)).toEqual([inA.id]);
      expect(await ids('?status=HELD')).toEqual([inB.id]);
      expect(await ids('?cancellationPending=true')).toEqual([inB.id]);
      expect(await ids('?cancellationPending=false')).toEqual([inA.id]);
    });

    it('rejects a malformed filter with 422 instead of ignoring it', async () => {
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      for (const query of ['?status=GONE', '?tripId=not-a-uuid', '?cancellationPending=yes']) {
        const response = await listRoute(request(`/api/v1/admin/reservations${query}`, token));
        expect(response.status).toBe(422);
        expect((await response.json()).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('GET /api/v1/admin/reservations/{id}', () => {
    it("returns any customer's reservation with the request reason, given reservation.view", async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id, { cancellationRequestedAt: new Date() });
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      const response = await detailRoute(
        request(`/api/v1/admin/reservations/${reservation.id}`, token),
        withId(reservation.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.code).toBe(reservation.code);
      expect(body.cancellationReason).toBe('Me enfermé');
      expect(body.cancellationPending).toBe(true);
      expect(body.tripName).toMatch(/^Viaje /);
      expect(body.customerEmail).toMatch(/@agency\.test$/);
    });

    it('requires reservation.view', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const token = await loginAs(db, 'canceller@agency.test', ['reservation.cancel']);

      const response = await detailRoute(
        request(`/api/v1/admin/reservations/${reservation.id}`, token),
        withId(reservation.id)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/admin/reservations/{id}/payments', () => {
    it("lists the reservation's payments given payment.view", async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      await db.payment.create({
        data: { reservationId: reservation.id, amountCents: 100_000, method: 'OXXO', status: 'PENDING', provider: 'STRIPE' },
      });
      const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

      const response = await listPaymentsRoute(
        request(`/api/v1/admin/reservations/${reservation.id}/payments`, token),
        withId(reservation.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ amountCents: 100_000, method: 'OXXO', status: 'PENDING' });
    });

    it('requires payment.view, not merely reservation.view', async () => {
      const trip = await seedTrip();
      const reservation = await seedReservation(trip.id);
      const token = await loginAs(db, 'viewer@agency.test', ['reservation.view']);

      const response = await listPaymentsRoute(
        request(`/api/v1/admin/reservations/${reservation.id}/payments`, token),
        withId(reservation.id)
      );

      expect(response.status).toBe(403);
    });
  });
});
