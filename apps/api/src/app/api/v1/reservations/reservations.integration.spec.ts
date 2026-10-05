import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { FakePaymentProvider, StripePaymentProvider } from '@rm/payments-stripe';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../test-support/auth-fixtures';
import { setPaymentProvider } from '../../../../lib/payment-provider';
import { setQueue } from '../../../../lib/queue';
import { GET as getReservationRoute } from './[reservationId]/route';
import { POST as requestCancellationRoute } from './[reservationId]/cancellation-requests/route';
import { POST as createPaymentIntentRoute } from './[reservationId]/payment-intents/route';
import { GET as listReservationsRoute, POST as createReservationRoute } from './route';

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

async function seedPublishedTrip(
  overrides: { holdTtlHours?: number; pricePerSeatCents?: number; minimumDepositCents?: number } = {}
) {
  const index = next();
  const staff = await db.user.create({
    data: { email: `staff-${index}@agency.test`, type: 'STAFF', staffProfile: { create: { fullName: 'Staff' } } },
  });
  return db.trip.create({
    data: {
      slug: `trip-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: overrides.holdTtlHours ?? 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.pricePerSeatCents ?? 500_000,
      createdById: staff.id,
      translations: {
        create: [{ locale: 'es', name: 'Viaje', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' }],
      },
    },
  });
}

async function createReservationFor(token: string, tripId: string) {
  const response = await createReservationRoute(
    request('/api/v1/reservations', token, { method: 'POST', body: JSON.stringify({ tripId }) })
  );
  return response;
}

describe('reservation endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    setQueue(await withTestQueue());
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    setPaymentProvider(new FakePaymentProvider());
  });
  afterEach(() => setPaymentProvider(undefined));
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  describe('POST /api/v1/reservations', () => {
    it('creates a HELD reservation for the authenticated customer', async () => {
      const trip = await seedPublishedTrip();
      const { token } = await loginAsCustomer(db, 'ana@agency.test');

      const response = await createReservationFor(token, trip.id);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe('HELD');
      expect(body.tripId).toBe(trip.id);
    });

    it('returns EMAIL_NOT_VERIFIED when the customer has not verified their email', async () => {
      const trip = await seedPublishedTrip();
      const { token } = await loginAsCustomer(db, 'unverified@agency.test', { emailVerified: false });

      const response = await createReservationFor(token, trip.id);

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const trip = await seedPublishedTrip();
      const response = await createReservationRoute(
        request('/api/v1/reservations', undefined, { method: 'POST', body: JSON.stringify({ tripId: trip.id }) })
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('a STAFF actor cannot create a reservation through the customer endpoint', async () => {
      const trip = await seedPublishedTrip();
      await seedPermissionCatalog(db);
      const staffToken = await loginAs(db, 'staff-member@agency.test', []);

      const response = await createReservationFor(staffToken, trip.id);

      // `createReservation` requires a `CustomerProfile`, which a STAFF user
      // never has -- the ownership-shaped reason staff cannot use this
      // endpoint, not a permission check.
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/reservations', () => {
    it('shows a customer only their own reservations', async () => {
      const trip = await seedPublishedTrip();
      const ana = await loginAsCustomer(db, 'ana-list@agency.test');
      const beto = await loginAsCustomer(db, 'beto-list@agency.test');
      await createReservationFor(ana.token, trip.id);
      await createReservationFor(beto.token, trip.id);

      const anaResponse = await listReservationsRoute(request('/api/v1/reservations', ana.token));
      const betoResponse = await listReservationsRoute(request('/api/v1/reservations', beto.token));

      const anaList = (await anaResponse.json()) as { customerId?: string }[];
      const betoList = (await betoResponse.json()) as { customerId?: string }[];
      expect(anaList).toHaveLength(1);
      expect(betoList).toHaveLength(1);
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await listReservationsRoute(request('/api/v1/reservations'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/reservations/{reservationId}', () => {
    it("returns 404 for another customer's reservation", async () => {
      const trip = await seedPublishedTrip();
      const owner = await loginAsCustomer(db, 'owner-get@agency.test');
      const stranger = await loginAsCustomer(db, 'stranger-get@agency.test');
      const created = await (await createReservationFor(owner.token, trip.id)).json();

      const response = await getReservationRoute(
        request(`/api/v1/reservations/${created.id}`, stranger.token),
        withId(created.id)
      );

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('RESERVATION_NOT_OWNED');
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await getReservationRoute(request('/api/v1/reservations/any-id'), withId('any-id'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('POST /api/v1/reservations/{reservationId}/cancellation-requests', () => {
    it('seals cancellation_requested_at, notifies staff, and leaves the status untouched', async () => {
      await seedPermissionCatalog(db);
      await loginAs(db, 'agent@agency.test', ['reservation.cancel']);
      const trip = await seedPublishedTrip();
      const { token } = await loginAsCustomer(db, 'cancel-me@agency.test');
      const created = await (await createReservationFor(token, trip.id)).json();
      expect(created.status).toBe('HELD');

      const response = await requestCancellationRoute(
        request(`/api/v1/reservations/${created.id}/cancellation-requests`, token, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Cambio de planes' }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      // The rule this test exists to protect: the easiest wrong
      // implementation flips the status. It must not.
      expect(body.status).toBe('HELD');
      expect(body.cancellationRequestedAt).not.toBeNull();

      const row = await db.reservation.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('HELD');
      expect(row.cancellationRequestedAt).not.toBeNull();

      // "avisa al personal": the staff member holding reservation.cancel
      // gets the alert, the customer who asked does not get a copy of it.
      const staffUser = await db.user.findUniqueOrThrow({ where: { email: 'agent@agency.test' } });
      const staffDeliveries = await db.notificationDelivery.count({
        where: { userId: staffUser.id, eventType: 'CANCELLATION_REQUESTED' },
      });
      expect(staffDeliveries).toBe(2); // one EMAIL row, one INBOX row
    });

    it("returns 404 for another customer's reservation", async () => {
      const trip = await seedPublishedTrip();
      const owner = await loginAsCustomer(db, 'owner-cancel@agency.test');
      const stranger = await loginAsCustomer(db, 'stranger-cancel@agency.test');
      const created = await (await createReservationFor(owner.token, trip.id)).json();

      const response = await requestCancellationRoute(
        request(`/api/v1/reservations/${created.id}/cancellation-requests`, stranger.token, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('RESERVATION_NOT_OWNED');
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await requestCancellationRoute(
        request('/api/v1/reservations/any-id/cancellation-requests', undefined, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        withId('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('POST /api/v1/reservations/{reservationId}/payment-intents', () => {
    it('computes the amount from the reservation balance -- a client-supplied amountCents is ignored entirely', async () => {
      const trip = await seedPublishedTrip({ pricePerSeatCents: 500_000 });
      const { token } = await loginAsCustomer(db, 'payer@agency.test');
      const created = await (await createReservationFor(token, trip.id)).json();

      const response = await createPaymentIntentRoute(
        request(`/api/v1/reservations/${created.id}/payment-intents`, token, {
          method: 'POST',
          // A malicious/confused client trying to name its own amount: the
          // schema has no such field, so this must be silently ignored, and
          // the real amount must come from the reservation's own price.
          body: JSON.stringify({ intent: 'FULL', method: 'CARD', amountCents: 1 }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.amountCents).toBe(500_000);

      const row = await db.payment.findUniqueOrThrow({ where: { providerIntentId: body.providerIntentId } });
      expect(row.amountCents).toBe(500_000);
    });

    it("returns 404 for another customer's reservation", async () => {
      const trip = await seedPublishedTrip();
      const owner = await loginAsCustomer(db, 'owner-intent@agency.test');
      const stranger = await loginAsCustomer(db, 'stranger-intent@agency.test');
      const created = await (await createReservationFor(owner.token, trip.id)).json();

      const response = await createPaymentIntentRoute(
        request(`/api/v1/reservations/${created.id}/payment-intents`, stranger.token, {
          method: 'POST',
          body: JSON.stringify({ intent: 'FULL', method: 'CARD' }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('RESERVATION_NOT_OWNED');
    });

    it.each(['EXPIRED', 'CANCELLED'] as const)('refuses to create an intent for a %s reservation', async (status) => {
      const trip = await seedPublishedTrip();
      const { token } = await loginAsCustomer(db, `terminal-${status}@agency.test`);
      const created = await (await createReservationFor(token, trip.id)).json();
      await db.reservation.update({ where: { id: created.id }, data: { status, holdExpiresAt: null } });

      const response = await createPaymentIntentRoute(
        request(`/api/v1/reservations/${created.id}/payment-intents`, token, {
          method: 'POST',
          body: JSON.stringify({ intent: 'FULL', method: 'CARD' }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('INVALID_STATUS_TRANSITION');
    });

    it("sets the OXXO voucher expiry to the reservation's holdExpiresAt", async () => {
      const trip = await seedPublishedTrip({ holdTtlHours: 48 });
      const { token } = await loginAsCustomer(db, 'oxxo-payer@agency.test');
      const created = await (await createReservationFor(token, trip.id)).json();

      const response = await createPaymentIntentRoute(
        request(`/api/v1/reservations/${created.id}/payment-intents`, token, {
          method: 'POST',
          body: JSON.stringify({ intent: 'FULL', method: 'OXXO' }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      const reservation = await db.reservation.findUniqueOrThrow({ where: { id: created.id } });
      expect(new Date(body.voucherExpiresAt).getTime()).toBe(reservation.holdExpiresAt?.getTime());
      expect(typeof body.voucherUrl).toBe('string');
    });

    it('surfaces the Stripe adapter refusing a sub-24h OXXO window as a clean 422, never a 500', async () => {
      setPaymentProvider(new StripePaymentProvider('sk_test_fake', 'whsec_test_fake'));
      // A 2-hour hold leaves less than a day for the voucher -- the exact
      // case `oxxoExpiresAfterDays` (`@rm/payments-stripe`) refuses rather
      // than round up past the hold.
      const trip = await seedPublishedTrip({ holdTtlHours: 2 });
      const { token } = await loginAsCustomer(db, 'short-hold@agency.test');
      const created = await (await createReservationFor(token, trip.id)).json();

      const response = await createPaymentIntentRoute(
        request(`/api/v1/reservations/${created.id}/payment-intents`, token, {
          method: 'POST',
          body: JSON.stringify({ intent: 'FULL', method: 'OXXO' }),
        }),
        withId(created.id)
      );

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(await db.payment.count()).toBe(0);
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await createPaymentIntentRoute(
        request('/api/v1/reservations/any-id/payment-intents', undefined, {
          method: 'POST',
          body: JSON.stringify({ intent: 'FULL', method: 'CARD' }),
        }),
        withId('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
