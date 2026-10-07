import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAsCustomer } from '../../../../test-support/auth-fixtures';
import { POST as markReadRoute } from './[deliveryId]/read/route';
import { GET as listInboxRoute } from './route';

const db = withTestDb();

function withId(deliveryId: string) {
  return { params: Promise.resolve({ deliveryId }) };
}

function request(url: string, token?: string, init: RequestInit = {}) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function seedDelivery(userId: string, overrides: { createdAt?: Date; channel?: 'INBOX' | 'EMAIL' } = {}) {
  return db.notificationDelivery.create({
    data: {
      userId,
      eventType: 'PAYMENT_CONFIRMED',
      channel: overrides.channel ?? 'INBOX',
      renderedTitle: 'Pago confirmado',
      renderedBody: 'Tu pago fue confirmado.',
      status: 'SENT',
      sentAt: new Date(),
      createdAt: overrides.createdAt ?? new Date(),
    },
  });
}

describe('notifications endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  describe('GET /api/v1/notifications', () => {
    it('lists only the customer\'s own deliveries, newest first, paginated', async () => {
      const { token, userId } = await loginAsCustomer(db, 'inbox-owner@agency.test');
      const other = await loginAsCustomer(db, 'inbox-stranger@agency.test');
      await seedDelivery(userId, { createdAt: new Date('2027-01-01T00:00:00Z') });
      const newest = await seedDelivery(userId, { createdAt: new Date('2027-01-03T00:00:00Z') });
      await seedDelivery(other.userId, { createdAt: new Date('2027-01-02T00:00:00Z') });

      const response = await listInboxRoute(request('/api/v1/notifications?limit=1', token));

      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: { id: string }[]; nextCursor: string | null; unreadCount: number };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(newest.id);
      expect(body.nextCursor).not.toBeNull();
      // Both of the owner's deliveries, not only the one on this page; never the stranger's.
      expect(body.unreadCount).toBe(2);
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await listInboxRoute(request('/api/v1/notifications'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('returns a clean 422 for a non-numeric limit, never a 500', async () => {
      const { token } = await loginAsCustomer(db, 'bad-limit@agency.test');

      const response = await listInboxRoute(request('/api/v1/notifications?limit=abc', token));

      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/notifications/{deliveryId}/read', () => {
    it("returns 404 for another customer's delivery", async () => {
      const owner = await loginAsCustomer(db, 'read-owner@agency.test');
      const stranger = await loginAsCustomer(db, 'read-stranger@agency.test');
      const delivery = await seedDelivery(owner.userId);

      const response = await markReadRoute(
        request(`/api/v1/notifications/${delivery.id}/read`, stranger.token, { method: 'POST' }),
        withId(delivery.id)
      );

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('DELIVERY_NOT_OWNED');
    });

    it('marks the own delivery as read', async () => {
      const { token, userId } = await loginAsCustomer(db, 'read-self@agency.test');
      const delivery = await seedDelivery(userId);

      const response = await markReadRoute(
        request(`/api/v1/notifications/${delivery.id}/read`, token, { method: 'POST' }),
        withId(delivery.id)
      );

      expect(response.status).toBe(204);
      const row = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('READ');
      expect(row.readAt).not.toBeNull();
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await markReadRoute(
        request('/api/v1/notifications/any-id/read', undefined, { method: 'POST' }),
        withId('any-id')
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
