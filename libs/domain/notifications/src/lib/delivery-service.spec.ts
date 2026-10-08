import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { SEND_NOTIFICATION_EMAIL_JOB } from '@rm/jobs';
import type { Db } from '@rm/db';
import { ConsoleEmailProvider, PROVIDER_REJECTED_TEST_ADDRESS, type EmailProvider, type EmailMessage } from '@rm/email';
import { deliverQueuedEmail, listInbox, markAllRead, markRead, notifyAdmins, notifyCustomer } from './delivery-service';

const db = withTestDb();
const email: EmailProvider = new ConsoleEmailProvider();

/** Counts calls without actually sending anything, for the idempotency test below. */
class CountingEmailProvider implements EmailProvider {
  calls = 0;
  async send(message: EmailMessage): ReturnType<EmailProvider['send']> {
    this.calls += 1;
    return email.send(message);
  }
}

let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

async function seedCustomer(client: Db, overrides: { email?: string; locale?: 'es' | 'en' } = {}): Promise<string> {
  const index = next();
  const user = await client.user.create({
    data: {
      email: overrides.email ?? `customer-${index}@agency.test`,
      type: 'CUSTOMER',
      locale: overrides.locale ?? 'es',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: {
          fullName: `Cliente ${index}`,
          phone: '5512345678',
          birthDate: new Date('1990-01-01'),
          origin: 'SELF_SIGNUP',
        },
      },
    },
  });
  return user.id;
}

/** A plain STAFF user with no roles at all -- never a recipient of `notifyAdmins`. */
async function seedPlainStaff(client: Db): Promise<string> {
  const index = next();
  const user = await client.user.create({
    data: {
      email: `staff-${index}@agency.test`,
      type: 'STAFF',
      staffProfile: { create: { fullName: `Staff ${index}` } },
    },
  });
  return user.id;
}

/** A STAFF user whose role grants `permissionKey`. */
async function seedStaffWithPermission(
  client: Db,
  permissionKey: string,
  overrides: { status?: 'ACTIVE' | 'DISABLED' } = {}
): Promise<string> {
  const index = next();
  const permission = await client.permission.upsert({
    where: { key: permissionKey },
    create: { key: permissionKey, category: 'reservations', description: permissionKey },
    update: {},
  });
  const role = await client.role.create({
    data: { name: `Role granting ${permissionKey} ${index}`, description: 'test role' },
  });
  await client.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const user = await client.user.create({
    data: {
      email: `staff-${index}@agency.test`,
      type: 'STAFF',
      status: overrides.status ?? 'ACTIVE',
      staffProfile: { create: { fullName: `Staff ${index}` } },
    },
  });
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

describe('notification delivery service', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await withTestQueue();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    sequence = 0;
  });

  afterAll(async () => {
    await closeTestDb();
    await closeTestQueue();
  });

  describe('notifyCustomer', () => {
    it('creates one EMAIL row (still PENDING) and one SENT INBOX row with the same rendered text, and enqueues the send', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();

      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_CONFIRMED',
          params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
        })
      );

      const rows = await db.notificationDelivery.findMany({ where: { userId: customerId } });
      expect(rows).toHaveLength(2);

      const emailRow = rows.find((row) => row.channel === 'EMAIL');
      const inboxRow = rows.find((row) => row.channel === 'INBOX');
      expect(emailRow).toBeDefined();
      expect(inboxRow).toBeDefined();
      expect(emailRow?.renderedTitle).toBe(inboxRow?.renderedTitle);
      expect(emailRow?.renderedBody).toBe(inboxRow?.renderedBody);
      expect(emailRow?.renderedBody).toContain('$500.00');
      // The real send is the worker's job now, not this call's: the row
      // starts and stays PENDING until `deliverQueuedEmail` runs.
      expect(emailRow?.status).toBe('PENDING');
      expect(inboxRow?.status).toBe('SENT');

      const jobs = await boss.findJobs(SEND_NOTIFICATION_EMAIL_JOB, { data: { deliveryId: emailRow?.id } });
      expect(jobs).toHaveLength(1);
    });

    it("renders in the customer's locale and freezes the text even if the locale changes later", async () => {
      const customerId = await seedCustomer(db, { locale: 'en' });
      const boss = await withTestQueue();

      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_CONFIRMED',
          params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
        })
      );

      const [firstDelivery] = await db.notificationDelivery.findMany({
        where: { userId: customerId, channel: 'INBOX' },
      });
      expect(firstDelivery.renderedBody).toContain('We received your payment');

      // Changing the customer's locale afterwards must not rewrite history.
      await db.user.update({ where: { id: customerId }, data: { locale: 'es' } });

      const stillInEnglish = await db.notificationDelivery.findUnique({ where: { id: firstDelivery.id } });
      expect(stillInEnglish?.renderedBody).toContain('We received your payment');

      // A new notice sent after the change renders in the new locale.
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_CONFIRMED',
          params: { tripName: 'Oaxaca', amount: '$100.00', balance: '$0.00' },
        })
      );
      const deliveries = await db.notificationDelivery.findMany({
        where: { userId: customerId, channel: 'INBOX' },
        orderBy: { createdAt: 'asc' },
      });
      expect(deliveries[1].renderedBody).toContain('Recibimos tu pago');
    });

    it('stamps the delivery with the reservationId it is about, when one is given', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();

      const trip = await db.trip.create({
        data: {
          slug: `oaxaca-${next()}`,
          departureDate: new Date('2027-12-01'),
          returnDate: new Date('2027-12-07'),
          paymentDeadline: new Date('2027-11-01'),
          totalCapacity: 20,
          holdTtlHours: 72,
          minimumDepositCents: 100000,
          createdById: (await seedPlainStaff(db)),
        },
      });
      const reservation = await db.reservation.create({
        data: {
          code: `RM-D${next()}`,
          tripId: trip.id,
          customerId,
          status: 'HELD',
          holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          totalPriceCents: 500000,
          minimumDepositCents: 100000,
          paymentDeadline: trip.paymentDeadline,
          source: 'APP',
        },
      });

      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          reservationId: reservation.id,
          eventType: 'HOLD_EXPIRING',
          params: { tripName: 'Oaxaca', holdExpiresAt: '2027-01-01' },
        })
      );

      const rows = await db.notificationDelivery.findMany({ where: { userId: customerId } });
      expect(rows.every((row) => row.reservationId === reservation.id)).toBe(true);
    });

    it('rolls back both delivery rows and the queued send when the caller rolls back the enclosing transaction', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();

      await expect(
        db.$transaction(async (tx) => {
          await notifyCustomer(tx, boss, {
            customerId,
            eventType: 'PAYMENT_CONFIRMED',
            params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
          });
          throw new Error('rollback the enclosing business transaction');
        })
      ).rejects.toThrow('rollback the enclosing business transaction');

      const rows = await db.notificationDelivery.findMany({ where: { userId: customerId } });
      expect(rows).toHaveLength(0);

      // The rows vanished with the transaction; the job pg-boss would have
      // inserted for them must have vanished too, same connection, same
      // rollback. No delivery id survives to filter by, so this asserts on
      // the whole queue rather than a specific payload -- `resetTestQueue()`
      // in `beforeEach` guarantees it was empty before this test ran.
      const jobs = await boss.findJobs(SEND_NOTIFICATION_EMAIL_JOB, {});
      expect(jobs).toHaveLength(0);
    });
  });

  describe('notifyAdmins', () => {
    it('writes one delivery pair per live staff user holding reservation.cancel, and one job per EMAIL row', async () => {
      const holder = await seedStaffWithPermission(db, 'reservation.cancel');
      const other = await seedStaffWithPermission(db, 'reservation.cancel');
      await seedPlainStaff(db); // holds nothing, must receive nothing
      const boss = await withTestQueue();

      await db.$transaction((tx) =>
        notifyAdmins(tx, boss, {
          eventType: 'CANCELLATION_REQUESTED',
          params: { reservationCode: 'RM-0001', customerName: 'Erick', reason: 'change of plans' },
        })
      );

      const holderRows = await db.notificationDelivery.findMany({ where: { userId: holder } });
      const otherRows = await db.notificationDelivery.findMany({ where: { userId: other } });
      expect(holderRows).toHaveLength(2);
      expect(otherRows).toHaveLength(2);

      const jobs = await boss.findJobs(SEND_NOTIFICATION_EMAIL_JOB, {});
      expect(jobs).toHaveLength(2);
    });

    it('never sends to a disabled staff user even if their role grants the permission', async () => {
      const disabled = await seedStaffWithPermission(db, 'reservation.cancel', { status: 'DISABLED' });
      const boss = await withTestQueue();

      await db.$transaction((tx) =>
        notifyAdmins(tx, boss, {
          eventType: 'CANCELLATION_REQUESTED',
          params: { reservationCode: 'RM-0001', customerName: 'Erick', reason: 'change of plans' },
        })
      );

      const rows = await db.notificationDelivery.findMany({ where: { userId: disabled } });
      expect(rows).toHaveLength(0);
    });

    it('writes nothing and does not throw when no staff holds the permission', async () => {
      await seedPlainStaff(db);
      const boss = await withTestQueue();

      await expect(
        db.$transaction((tx) =>
          notifyAdmins(tx, boss, {
            eventType: 'ORPHAN_PAYMENT',
            params: { amount: '$500.00', provider: 'OXXO', intentId: 'pi_123' },
          })
        )
      ).resolves.not.toThrow();

      const rows = await db.notificationDelivery.findMany({});
      expect(rows).toHaveLength(0);
    });
  });

  describe('deliverQueuedEmail', () => {
    it('sends the EMAIL row through the provider and marks it SENT', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_CONFIRMED',
          params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
        })
      );
      const emailRow = await db.notificationDelivery.findFirstOrThrow({
        where: { userId: customerId, channel: 'EMAIL' },
      });

      await deliverQueuedEmail(db, email, emailRow.id);

      const updated = await db.notificationDelivery.findUniqueOrThrow({ where: { id: emailRow.id } });
      expect(updated.status).toBe('SENT');
      expect(updated.sentAt).not.toBeNull();
    });

    it('escapes the rendered text in the HTML part: a customer-written reason never becomes markup in a staff inbox', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'RESERVATION_CANCELLED',
          params: { tripName: 'Oaxaca', reason: '<a href="https://phish.test">Ver reserva</a><img src=x>' },
        })
      );
      const emailRow = await db.notificationDelivery.findFirstOrThrow({
        where: { userId: customerId, channel: 'EMAIL' },
      });
      const sent: { html: string; text: string }[] = [];
      const capturing: EmailProvider = {
        send: async (message) => {
          sent.push({ html: message.html, text: message.text });
          return { ok: true, value: { providerMessageId: 'captured' } };
        },
      };

      await deliverQueuedEmail(db, capturing, emailRow.id);

      expect(sent).toHaveLength(1);
      expect(sent[0]?.html).not.toContain('<a href');
      expect(sent[0]?.html).not.toContain('<img');
      expect(sent[0]?.html).toContain('&lt;a href=&quot;https://phish.test&quot;&gt;');
      // The plain-text part is not HTML and stays readable as written.
      expect(sent[0]?.text).toContain('<a href="https://phish.test">');
    });

    it('marks the EMAIL row FAILED with the error and leaves INBOX SENT, without throwing, when the provider rejects the address', async () => {
      const customerId = await seedCustomer(db, { email: PROVIDER_REJECTED_TEST_ADDRESS });
      const boss = await withTestQueue();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_FAILED',
          params: { tripName: 'Oaxaca', reason: 'insufficient funds' },
        })
      );
      const emailRow = await db.notificationDelivery.findFirstOrThrow({
        where: { userId: customerId, channel: 'EMAIL' },
      });

      await expect(deliverQueuedEmail(db, email, emailRow.id)).resolves.not.toThrow();

      const updatedEmail = await db.notificationDelivery.findUniqueOrThrow({ where: { id: emailRow.id } });
      const inboxRow = await db.notificationDelivery.findFirstOrThrow({
        where: { userId: customerId, channel: 'INBOX' },
      });
      expect(updatedEmail.status).toBe('FAILED');
      expect(updatedEmail.error).toBeTruthy();
      expect(inboxRow.status).toBe('SENT');
    });

    it('is a no-op the second time it runs for the same delivery (pg-boss redelivers at least once)', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      const counting = new CountingEmailProvider();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'PAYMENT_CONFIRMED',
          params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
        })
      );
      const emailRow = await db.notificationDelivery.findFirstOrThrow({
        where: { userId: customerId, channel: 'EMAIL' },
      });

      await deliverQueuedEmail(db, counting, emailRow.id);
      await deliverQueuedEmail(db, counting, emailRow.id);

      expect(counting.calls).toBe(1);
      const updated = await db.notificationDelivery.findUniqueOrThrow({ where: { id: emailRow.id } });
      expect(updated.status).toBe('SENT');
    });
  });

  describe('listInbox', () => {
    it('returns the most recent INBOX deliveries first and never EMAIL deliveries', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      for (let i = 0; i < 3; i += 1) {
        await db.$transaction((tx) =>
          notifyCustomer(tx, boss, {
            customerId,
            eventType: 'HOLD_EXPIRING',
            params: { tripName: `Trip ${i}`, holdExpiresAt: '2027-01-01' },
          })
        );
      }

      const page = await listInbox(db, customerId, { limit: 10 });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.items).toHaveLength(3);
      expect(page.value.items.every((item) => item.body.length > 0)).toBe(true);
      expect(page.value.items[0].body).toContain('Trip 2');
      expect(page.value.items[2].body).toContain('Trip 0');
    });

    it('pages by cursor without repeating or skipping rows', async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      for (let i = 0; i < 5; i += 1) {
        await db.$transaction((tx) =>
          notifyCustomer(tx, boss, {
            customerId,
            eventType: 'HOLD_EXPIRING',
            params: { tripName: `Trip ${i}`, holdExpiresAt: '2027-01-01' },
          })
        );
      }

      const firstPage = await listInbox(db, customerId, { limit: 2 });
      expect(firstPage.ok).toBe(true);
      if (!firstPage.ok) return;
      expect(firstPage.value.items).toHaveLength(2);
      expect(firstPage.value.nextCursor).not.toBeNull();

      const secondPage = await listInbox(db, customerId, { limit: 2, cursor: firstPage.value.nextCursor ?? undefined });
      expect(secondPage.ok).toBe(true);
      if (!secondPage.ok) return;
      expect(secondPage.value.items).toHaveLength(2);

      const thirdPage = await listInbox(db, customerId, { limit: 2, cursor: secondPage.value.nextCursor ?? undefined });
      expect(thirdPage.ok).toBe(true);
      if (!thirdPage.ok) return;
      expect(thirdPage.value.items).toHaveLength(1);
      expect(thirdPage.value.nextCursor).toBeNull();

      const allIds = [...firstPage.value.items, ...secondPage.value.items, ...thirdPage.value.items].map(
        (item) => item.id
      );
      expect(new Set(allIds).size).toBe(5);
    });

    it("counts the customer's own unread INBOX deliveries across every page, not just the one returned", async () => {
      const customerId = await seedCustomer(db);
      const otherCustomerId = await seedCustomer(db);
      const boss = await withTestQueue();
      for (const owner of [customerId, customerId, customerId, otherCustomerId]) {
        await db.$transaction((tx) =>
          notifyCustomer(tx, boss, { customerId: owner, eventType: 'HOLD_EXPIRED', params: { tripName: 'Oaxaca' } })
        );
      }
      const [first] = await db.notificationDelivery.findMany({ where: { userId: customerId, channel: 'INBOX' } });
      await markRead(db, first.id, customerId);

      const page = await listInbox(db, customerId, { limit: 1 });

      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.items).toHaveLength(1);
      // 3 INBOX rows, 1 read; the EMAIL twins and the other customer's row never count.
      expect(page.value.unreadCount).toBe(2);
    });
  });

  describe('inbox item reservation link', () => {
    async function seedReservationFor(customerId: string): Promise<string> {
      const trip = await db.trip.create({
        data: {
          slug: `link-${next()}`,
          departureDate: new Date('2027-12-01'),
          returnDate: new Date('2027-12-07'),
          paymentDeadline: new Date('2027-11-01'),
          totalCapacity: 20,
          holdTtlHours: 72,
          minimumDepositCents: 100000,
          createdById: await seedPlainStaff(db),
        },
      });
      const reservation = await db.reservation.create({
        data: {
          code: `RM-L${next()}`,
          tripId: trip.id,
          customerId,
          status: 'HELD',
          holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          totalPriceCents: 500000,
          minimumDepositCents: 100000,
          paymentDeadline: trip.paymentDeadline,
          source: 'APP',
        },
      });
      return reservation.id;
    }

    it('carries the reservation an item is about so the panel can link to it, and null when there is none', async () => {
      const customerId = await seedCustomer(db);
      const staffId = await seedStaffWithPermission(db, 'reservation.cancel');
      const reservationId = await seedReservationFor(customerId);
      const boss = await withTestQueue();
      await db.$transaction(async (tx) => {
        await notifyAdmins(tx, boss, {
          eventType: 'CANCELLATION_REQUESTED',
          params: { customerName: 'Ana', tripName: 'Oaxaca', reservationCode: 'RM-1', reason: 'x' },
          reservationId,
        });
        await notifyAdmins(tx, boss, {
          eventType: 'ORPHAN_PAYMENT',
          params: { paymentId: 'pay-1', amount: '$1.00', reservationCode: 'RM-1' },
        });
      });

      const page = await listInbox(db, staffId, { limit: 10 });

      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const byEvent = new Map(page.value.items.map((item) => [item.eventType, item.reservationId]));
      expect(byEvent.get('CANCELLATION_REQUESTED')).toBe(reservationId);
      expect(byEvent.get('ORPHAN_PAYMENT')).toBeNull();
    });
  });

  describe('markAllRead', () => {
    async function inboxRow(userId: string, readAt: Date | null) {
      return db.notificationDelivery.create({
        data: {
          userId,
          eventType: 'ORPHAN_PAYMENT',
          channel: 'INBOX',
          renderedTitle: 't',
          renderedBody: 'b',
          status: readAt ? 'READ' : 'SENT',
          sentAt: new Date('2027-01-01T00:00:00Z'),
          readAt,
        },
      });
    }

    it("marks every unread INBOX delivery of the caller as read and nothing else", async () => {
      const staffId = await seedStaffWithPermission(db, 'reservation.cancel');
      const otherStaffId = await seedStaffWithPermission(db, 'reservation.cancel');
      const earlier = new Date('2027-01-02T00:00:00Z');
      const unreadA = await inboxRow(staffId, null);
      const unreadB = await inboxRow(staffId, null);
      const alreadyRead = await inboxRow(staffId, earlier);
      const othersUnread = await inboxRow(otherStaffId, null);
      const email = await db.notificationDelivery.create({
        data: { userId: staffId, eventType: 'ORPHAN_PAYMENT', channel: 'EMAIL', renderedTitle: 't', renderedBody: 'b', status: 'PENDING' },
      });

      const result = await markAllRead(db, staffId);

      expect(result.ok).toBe(true);
      const rows = new Map((await db.notificationDelivery.findMany()).map((row) => [row.id, row]));
      for (const id of [unreadA.id, unreadB.id]) {
        expect(rows.get(id)).toMatchObject({ status: 'READ' });
        expect(rows.get(id)?.readAt).not.toBeNull();
      }
      expect(rows.get(alreadyRead.id)?.readAt).toEqual(earlier);
      expect(rows.get(othersUnread.id)).toMatchObject({ status: 'SENT', readAt: null });
      expect(rows.get(email.id)).toMatchObject({ status: 'PENDING', readAt: null });

      const page = await listInbox(db, staffId, {});
      expect(page.ok && page.value.unreadCount).toBe(0);
    });

    it('succeeds when there is nothing unread, and again when repeated', async () => {
      const staffId = await seedStaffWithPermission(db, 'reservation.cancel');
      await inboxRow(staffId, null);

      expect((await markAllRead(db, staffId)).ok).toBe(true);
      expect((await markAllRead(db, staffId)).ok).toBe(true);
    });
  });

  describe('markRead', () => {
    it("marks a customer's own delivery as read", async () => {
      const customerId = await seedCustomer(db);
      const boss = await withTestQueue();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'HOLD_EXPIRED',
          params: { tripName: 'Oaxaca' },
        })
      );
      const [delivery] = await db.notificationDelivery.findMany({ where: { userId: customerId, channel: 'INBOX' } });

      const result = await markRead(db, delivery.id, customerId);

      expect(result.ok).toBe(true);
      const updated = await db.notificationDelivery.findUnique({ where: { id: delivery.id } });
      expect(updated?.status).toBe('READ');
      expect(updated?.readAt).not.toBeNull();
    });

    it('returns DELIVERY_NOT_OWNED, not a confirmation, for a delivery belonging to someone else', async () => {
      const customerId = await seedCustomer(db);
      const otherCustomerId = await seedCustomer(db);
      const boss = await withTestQueue();
      await db.$transaction((tx) =>
        notifyCustomer(tx, boss, {
          customerId,
          eventType: 'HOLD_EXPIRED',
          params: { tripName: 'Oaxaca' },
        })
      );
      const [delivery] = await db.notificationDelivery.findMany({ where: { userId: customerId, channel: 'INBOX' } });

      const result = await markRead(db, delivery.id, otherCustomerId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DELIVERY_NOT_OWNED');
    });

    it('returns DELIVERY_NOT_OWNED for an id that does not exist', async () => {
      const customerId = await seedCustomer(db);

      const result = await markRead(db, '00000000-0000-0000-0000-000000000000', customerId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DELIVERY_NOT_OWNED');
    });
  });
});
