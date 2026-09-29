import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, seedPermissionCatalog } from '../../../../../../test-support/auth-fixtures';
import { POST as createTripRoute } from '../../route';
import { GET as getCostingRoute, PUT as setPricingPolicyRoute } from './route';
import { DELETE as deleteItemRoute, PUT as updateItemRoute } from './items/[itemId]/route';
import { POST as addItemRoute } from './items/route';

const db = withTestDb();

function withParams(tripId: string, extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ tripId, ...extra }) };
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
    { locale: 'es', name: 'Sierra Norte', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
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

async function createTrip(token: string) {
  const response = await createTripRoute(request('/api/v1/trips', token, { method: 'POST', body: JSON.stringify(tripBody) }));
  return response.json();
}

async function addItem(token: string, tripId: string, body: Record<string, unknown>) {
  return addItemRoute(
    request(`/api/v1/trips/${tripId}/costing/items`, token, { method: 'POST', body: JSON.stringify(body) }),
    withParams(tripId)
  );
}

describe('costing endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
  });
  afterAll(() => closeTestDb());

  describe('POST /api/v1/trips/:tripId/costing/items', () => {
    it('adds a budget item and reprices the trip for an actor holding trip.budget.manage', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);

      const response = await addItem(creator, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 });

      expect(response.status).toBe(201);
      const costing = await response.json();
      expect(costing.budgetTotalCents).toBe(500000);
      expect(costing.pricePerSeatCents).toBe(30000);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.budget.view']);

      const response = await addItem(token, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await addItemRoute(
        new Request('http://localhost/api/v1/trips/any-id/costing/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ concept: 'Bus', quantity: 1, unitAmountCents: 500000 }),
        }),
        withParams('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/trips/:tripId/costing', () => {
    it('succeeds for an actor holding trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.budget.view']);

      const response = await getCostingRoute(request(`/api/v1/trips/${created.id}/costing`, token), withParams(created.id));
      expect(response.status).toBe(200);
    });

    it('returns 403 PERMISSION_DENIED for an authenticated actor without trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'nobody@agency.test', []);

      const response = await getCostingRoute(request(`/api/v1/trips/${created.id}/costing`, token), withParams(created.id));
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await getCostingRoute(request('/api/v1/trips/any-id/costing'), withParams('any-id'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT /api/v1/trips/:tripId/costing', () => {
    it('succeeds for an actor holding trip.budget.manage', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);

      const response = await setPricingPolicyRoute(
        request(`/api/v1/trips/${created.id}/costing`, creator, {
          method: 'PUT',
          body: JSON.stringify({ marginMode: 'FIXED_TOTAL', marginValue: 100000, priceMode: 'AUTO' }),
        }),
        withParams(created.id)
      );
      expect(response.status).toBe(200);
      expect((await response.json()).marginMode).toBe('FIXED_TOTAL');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.budget.view']);

      const response = await setPricingPolicyRoute(
        request(`/api/v1/trips/${created.id}/costing`, token, {
          method: 'PUT',
          body: JSON.stringify({ marginMode: 'FIXED_TOTAL', marginValue: 100000, priceMode: 'AUTO' }),
        }),
        withParams(created.id)
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await setPricingPolicyRoute(
        new Request('http://localhost/api/v1/trips/any-id/costing', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ marginMode: 'FIXED_TOTAL', marginValue: 100000, priceMode: 'AUTO' }),
        }),
        withParams('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT /api/v1/trips/:tripId/costing/items/:itemId', () => {
    it('succeeds for an actor holding trip.budget.manage', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);
      const added = await (await addItem(creator, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 })).json();
      const itemId = added.items[0].id;

      const response = await updateItemRoute(
        request(`/api/v1/trips/${created.id}/costing/items/${itemId}`, creator, {
          method: 'PUT',
          body: JSON.stringify({ concept: 'Bus VIP', quantity: 1, unitAmountCents: 600000 }),
        }),
        withParams(created.id, { itemId })
      );
      expect(response.status).toBe(200);
      expect((await response.json()).budgetTotalCents).toBe(600000);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);
      const added = await (await addItem(creator, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 })).json();
      const itemId = added.items[0].id;
      const token = await loginAs(db, 'viewer@agency.test', ['trip.budget.view']);

      const response = await updateItemRoute(
        request(`/api/v1/trips/${created.id}/costing/items/${itemId}`, token, {
          method: 'PUT',
          body: JSON.stringify({ concept: 'Bus VIP', quantity: 1, unitAmountCents: 600000 }),
        }),
        withParams(created.id, { itemId })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await updateItemRoute(
        new Request('http://localhost/api/v1/trips/any-id/costing/items/any-item', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ concept: 'Bus VIP', quantity: 1, unitAmountCents: 600000 }),
        }),
        withParams('any-id', { itemId: 'any-item' })
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('DELETE /api/v1/trips/:tripId/costing/items/:itemId', () => {
    it('succeeds for an actor holding trip.budget.manage', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);
      const added = await (await addItem(creator, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 })).json();
      const itemId = added.items[0].id;

      const response = await deleteItemRoute(
        request(`/api/v1/trips/${created.id}/costing/items/${itemId}`, creator, { method: 'DELETE' }),
        withParams(created.id, { itemId })
      );
      expect(response.status).toBe(200);
      expect((await response.json()).budgetTotalCents).toBe(0);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.budget.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create', 'trip.budget.manage']);
      const created = await createTrip(creator);
      const added = await (await addItem(creator, created.id, { concept: 'Bus', quantity: 1, unitAmountCents: 500000 })).json();
      const itemId = added.items[0].id;
      const token = await loginAs(db, 'viewer@agency.test', ['trip.budget.view']);

      const response = await deleteItemRoute(
        request(`/api/v1/trips/${created.id}/costing/items/${itemId}`, token, { method: 'DELETE' }),
        withParams(created.id, { itemId })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await deleteItemRoute(
        new Request('http://localhost/api/v1/trips/any-id/costing/items/any-item', { method: 'DELETE' }),
        withParams('any-id', { itemId: 'any-item' })
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
