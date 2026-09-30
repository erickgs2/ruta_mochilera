import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, seedPermissionCatalog } from '../../../../test-support/auth-fixtures';
import { GET as getTripRoute, PUT as updateTripRoute } from './[tripId]/route';
import { PUT as changeStatusRoute } from './[tripId]/status/route';
import { GET as listTripsRoute, POST as createTripRoute } from './route';

const db = withTestDb();

function withTripId(tripId: string) {
  return { params: Promise.resolve({ tripId }) };
}

const tripBody = {
  departureDate: '2027-03-01',
  returnDate: '2027-03-07',
  paymentDeadline: '2027-02-01',
  totalCapacity: 20,
  preSoldSeats: 0,
  holdTtlHours: 72,
  minimumDepositCents: 100000,
  marginMode: 'PERCENTAGE',
  marginValue: 2000,
  translations: [
    { locale: 'es', name: 'Huasteca Potosina', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
  ],
};

function request(url: string, token?: string, init: RequestInit = {}) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function createTrip(token: string, overrides: Partial<typeof tripBody> = {}) {
  const response = await createTripRoute(
    request('/api/v1/trips', token, { method: 'POST', body: JSON.stringify({ ...tripBody, ...overrides }) })
  );
  return response.json();
}

describe('trip endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
  });
  afterAll(() => closeTestDb());

  describe('POST /api/v1/trips', () => {
    it('creates a trip for an actor holding trip.create', async () => {
      const token = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const response = await createTripRoute(
        request('/api/v1/trips', token, { method: 'POST', body: JSON.stringify(tripBody) })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.slug).toBe('huasteca-potosina-2027');
      expect(body.status).toBe('DRAFT');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.view', async () => {
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view']);
      const response = await createTripRoute(
        request('/api/v1/trips', token, { method: 'POST', body: JSON.stringify(tripBody) })
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await createTripRoute(
        request('/api/v1/trips', undefined, { method: 'POST', body: JSON.stringify(tripBody) })
      );

      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('returns 403 when backfilling without data.backfill', async () => {
      const token = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const response = await createTripRoute(
        request('/api/v1/trips', token, {
          method: 'POST',
          body: JSON.stringify({ ...tripBody, preSoldSeats: 5, isBackfilled: true }),
        })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('GET /api/v1/trips', () => {
    it('succeeds for an actor holding trip.view', async () => {
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view']);
      const response = await listTripsRoute(request('/api/v1/trips', token));
      expect(response.status).toBe(200);
    });

    it('returns 403 PERMISSION_DENIED for an authenticated actor without trip.view', async () => {
      const token = await loginAs(db, 'nobody@agency.test', []);
      const response = await listTripsRoute(request('/api/v1/trips', token));
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await listTripsRoute(request('/api/v1/trips'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/trips/:tripId', () => {
    it('succeeds for an actor holding trip.view', async () => {
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view', 'trip.create']);
      const created = await createTrip(token);

      const response = await getTripRoute(request(`/api/v1/trips/${created.id}`, token), withTripId(created.id));
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(created.id);
    });

    it('returns 403 PERMISSION_DENIED for an authenticated actor without trip.view', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      const token = await loginAs(db, 'nobody@agency.test', []);

      const response = await getTripRoute(request(`/api/v1/trips/${created.id}`, token), withTripId(created.id));
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await getTripRoute(request('/api/v1/trips/any-id'), withTripId('any-id'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT /api/v1/trips/:tripId', () => {
    it('succeeds for an actor holding trip.update', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const response = await updateTripRoute(
        request(`/api/v1/trips/${created.id}`, token, { method: 'PUT', body: JSON.stringify({ ...tripBody, totalCapacity: 30 }) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(200);
      expect((await response.json()).totalCapacity).toBe(30);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.view', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view']);

      const response = await updateTripRoute(
        request(`/api/v1/trips/${created.id}`, token, { method: 'PUT', body: JSON.stringify(tripBody) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await updateTripRoute(
        request('/api/v1/trips/any-id', undefined, { method: 'PUT', body: JSON.stringify(tripBody) }),
        withTripId('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT /api/v1/trips/:tripId/status', () => {
    it('succeeds for an actor holding both trip.publish and trip.cancel when cancelling', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      // The route's own static permission still requires `trip.publish` as a
      // coarse pre-check on every call to this endpoint (see the route file
      // and `docs/business-rules/trips.md`), so cancelling through the real
      // HTTP path needs both permissions, not `trip.cancel` alone.
      const token = await loginAs(db, 'canceller@agency.test', ['trip.publish', 'trip.cancel']);

      const response = await changeStatusRoute(
        request(`/api/v1/trips/${created.id}/status`, token, { method: 'PUT', body: JSON.stringify({ status: 'CANCELLED' }) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe('CANCELLED');
    });

    it('succeeds for an actor holding only trip.publish when the target is not CANCELLED', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      // Publishing has its own, unrelated requirements (at least one image
      // and a positive price -- see TRIP_NOT_PUBLISHABLE); satisfy them here
      // so this test's 200 is about the permission split, not those.
      await db.tripImage.create({
        data: { tripId: created.id, storageKey: 'trips/x/1.jpg', position: 0, isCover: true },
      });
      await db.trip.update({ where: { id: created.id }, data: { pricePerSeatCents: 1_500_000 } });
      const token = await loginAs(db, 'publisher@agency.test', ['trip.publish']);

      const response = await changeStatusRoute(
        request(`/api/v1/trips/${created.id}/status`, token, { method: 'PUT', body: JSON.stringify({ status: 'PUBLISHED' }) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe('PUBLISHED');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding trip.publish but not trip.cancel when cancelling', async () => {
      // This is the precise check `changeTripStatus` performs (see
      // `docs/business-rules/trips.md`): `trip.publish` alone is enough to
      // reach the endpoint, but cancelling a trip is a separate, deliberately
      // narrower permission an administrator has to hold on top of it.
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      const token = await loginAs(db, 'publisher-only@agency.test', ['trip.publish']);

      const response = await changeStatusRoute(
        request(`/api/v1/trips/${created.id}/status`, token, { method: 'PUT', body: JSON.stringify({ status: 'CANCELLED' }) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.update', async () => {
      const creatorToken = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creatorToken);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const response = await changeStatusRoute(
        request(`/api/v1/trips/${created.id}/status`, token, { method: 'PUT', body: JSON.stringify({ status: 'CANCELLED' }) }),
        withTripId(created.id)
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await changeStatusRoute(
        request('/api/v1/trips/any-id/status', undefined, { method: 'PUT', body: JSON.stringify({ status: 'CANCELLED' }) }),
        withTripId('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
