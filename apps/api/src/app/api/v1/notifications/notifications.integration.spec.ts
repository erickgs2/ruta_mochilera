import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../test-support/auth-fixtures';
import { POST as markReadRoute } from './[deliveryId]/read/route';
import { POST as markAllReadRoute } from './read-all/route';
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

  describe('GET /api/v1/notifications?unreadOnly', () => {
    type Page = { items: { id: string }[]; nextCursor: string | null; unreadCount: number };
    const list = async (url: string, token: string) => (await (await listInboxRoute(request(url, token))).json()) as Page;

    it("returns only the caller's unread INBOX rows, never read ones, EMAIL ones or a stranger's", async () => {
      const { token, userId } = await loginAsCustomer(db, 'unread-owner@agency.test');
      const other = await loginAsCustomer(db, 'unread-stranger@agency.test');
      const unread = await seedDelivery(userId, { createdAt: new Date('2027-01-03T00:00:00Z') });
      const read = await seedDelivery(userId, { createdAt: new Date('2027-01-02T00:00:00Z') });
      await db.notificationDelivery.update({ where: { id: read.id }, data: { status: 'READ', readAt: new Date() } });
      await seedDelivery(userId, { channel: 'EMAIL' });
      await seedDelivery(other.userId);

      const filtered = await list('/api/v1/notifications?unreadOnly=true', token);
      expect(filtered.items.map((item) => item.id)).toEqual([unread.id]);
      expect(filtered.unreadCount).toBe(1);

      const everything = await list('/api/v1/notifications?unreadOnly=false', token);
      expect(everything.items.map((item) => item.id)).toEqual([unread.id, read.id]);
      const omitted = await list('/api/v1/notifications', token);
      expect(omitted.items.map((item) => item.id)).toEqual([unread.id, read.id]);
    });

    it('pages with the filter on without skipping or repeating a row, even with equal timestamps', async () => {
      const { token, userId } = await loginAsCustomer(db, 'unread-pages@agency.test');
      const sameInstant = new Date('2027-02-01T00:00:00Z');
      const expected: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const unread = await seedDelivery(userId, { createdAt: sameInstant });
        expected.push(unread.id);
        const read = await seedDelivery(userId, { createdAt: sameInstant });
        await db.notificationDelivery.update({ where: { id: read.id }, data: { status: 'READ', readAt: new Date() } });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `/api/v1/notifications?unreadOnly=true&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: Page = await list(query, token);
        seen.push(...page.items.map((item) => item.id));
        expect(page.unreadCount).toBe(5);
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect([...seen].sort()).toEqual([...expected].sort());
    });

    it.each(['1', 'TRUE', 'yes', ''])('answers 422 VALIDATION_FAILED for unreadOnly=%j', async (value) => {
      const { token } = await loginAsCustomer(db, `unread-bad-${value || 'empty'}@agency.test`);

      const response = await listInboxRoute(request(`/api/v1/notifications?unreadOnly=${value}`, token));

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

  describe('POST /api/v1/notifications/read-all', () => {
    const noParams = { params: Promise.resolve({}) };

    it("marks all of the caller's unread deliveries as read (204) and leaves everyone else's alone", async () => {
      const { token, userId } = await loginAsCustomer(db, 'read-all-owner@agency.test');
      const other = await loginAsCustomer(db, 'read-all-stranger@agency.test');
      await seedDelivery(userId);
      await seedDelivery(userId);
      const strangers = await seedDelivery(other.userId);

      const response = await markAllReadRoute(request('/api/v1/notifications/read-all', token, { method: 'POST' }), noParams);

      expect(response.status).toBe(204);
      expect(await db.notificationDelivery.count({ where: { userId, readAt: null } })).toBe(0);
      expect(await db.notificationDelivery.findUniqueOrThrow({ where: { id: strangers.id } })).toMatchObject({ readAt: null, status: 'SENT' });

      const inbox = (await (await listInboxRoute(request('/api/v1/notifications', token))).json()) as { unreadCount: number };
      expect(inbox.unreadCount).toBe(0);
    });

    it('works for staff with no permission at all, since it only touches their own inbox', async () => {
      await seedPermissionCatalog(db);
      const token = await loginAs(db, 'bare-staff@agency.test', []);
      const staff = await db.user.findUniqueOrThrow({ where: { email: 'bare-staff@agency.test' } });
      await seedDelivery(staff.id);

      const response = await markAllReadRoute(request('/api/v1/notifications/read-all', token, { method: 'POST' }), noParams);

      expect(response.status).toBe(204);
      expect(await db.notificationDelivery.count({ where: { userId: staff.id, readAt: null } })).toBe(0);
    });

    it('returns 401 for an unauthenticated caller', async () => {
      const response = await markAllReadRoute(request('/api/v1/notifications/read-all', undefined, { method: 'POST' }), noParams);
      expect(response.status).toBe(401);
    });
  });

  describe('the inbox item', () => {
    it('carries the reservation id so the panel can link to it, null when there is none', async () => {
      const { token, userId } = await loginAsCustomer(db, 'link-owner@agency.test');
      const staff = await db.user.create({ data: { email: 'link-creator@agency.test', type: 'STAFF' } });
      const trip = await db.trip.create({
        data: {
          slug: 'link-trip',
          departureDate: new Date('2028-03-01'),
          returnDate: new Date('2028-03-07'),
          paymentDeadline: new Date('2028-02-01'),
          totalCapacity: 20,
          holdTtlHours: 72,
          minimumDepositCents: 100_000,
          createdById: staff.id,
        },
      });
      const reservation = await db.reservation.create({
        data: {
          code: 'RM-LINK',
          tripId: trip.id,
          customerId: userId,
          status: 'HELD',
          holdExpiresAt: new Date('2028-01-01'),
          totalPriceCents: 500_000,
          minimumDepositCents: 100_000,
          paymentDeadline: trip.paymentDeadline,
          source: 'APP',
        },
      });
      const withLink = await seedDelivery(userId, { createdAt: new Date('2027-01-02T00:00:00Z') });
      await db.notificationDelivery.update({ where: { id: withLink.id }, data: { reservationId: reservation.id } });
      const withoutLink = await seedDelivery(userId, { createdAt: new Date('2027-01-01T00:00:00Z') });

      const body = (await (await listInboxRoute(request('/api/v1/notifications', token))).json()) as {
        items: { id: string; reservationId: string | null }[];
      };

      expect(body.items.find((item) => item.id === withLink.id)?.reservationId).toBe(reservation.id);
      expect(body.items.find((item) => item.id === withoutLink.id)?.reservationId).toBeNull();
    });
  });
});
