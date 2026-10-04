import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db } from '@rm/db';
import { ConsoleEmailProvider, PROVIDER_REJECTED_TEST_ADDRESS, type EmailProvider } from '@rm/email';
import { listInbox, markRead, notifyAdmins, notifyCustomer } from './delivery-service';

const db = withTestDb();
const email: EmailProvider = new ConsoleEmailProvider();

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
  beforeAll(() => prepareTestDb());

  beforeEach(async () => {
    await resetDatabase(db);
    sequence = 0;
  });

  afterAll(() => closeTestDb());

  describe('notifyCustomer', () => {
    it('creates one EMAIL row and one INBOX row with the same rendered text', async () => {
      const customerId = await seedCustomer(db);

      await db.$transaction((tx) =>
        notifyCustomer(tx, email, {
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
      expect(emailRow?.status).toBe('SENT');
      expect(inboxRow?.status).toBe('SENT');
    });

    it("renders in the customer's locale and freezes the text even if the locale changes later", async () => {
      const customerId = await seedCustomer(db, { locale: 'en' });

      await db.$transaction((tx) =>
        notifyCustomer(tx, email, {
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
        notifyCustomer(tx, email, {
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

    it('marks the EMAIL row FAILED with the error and leaves INBOX SENT, without throwing, on a provider failure', async () => {
      const customerId = await seedCustomer(db, { email: PROVIDER_REJECTED_TEST_ADDRESS });

      await expect(
        db.$transaction((tx) =>
          notifyCustomer(tx, email, {
            customerId,
            eventType: 'PAYMENT_FAILED',
            params: { tripName: 'Oaxaca', reason: 'insufficient funds' },
          })
        )
      ).resolves.not.toThrow();

      const rows = await db.notificationDelivery.findMany({ where: { userId: customerId } });
      const emailRow = rows.find((row) => row.channel === 'EMAIL');
      const inboxRow = rows.find((row) => row.channel === 'INBOX');
      expect(emailRow?.status).toBe('FAILED');
      expect(emailRow?.error).toBeTruthy();
      expect(inboxRow?.status).toBe('SENT');
    });

    it('rolls back both delivery rows when the caller rolls back the enclosing transaction', async () => {
      const customerId = await seedCustomer(db);

      await expect(
        db.$transaction(async (tx) => {
          await notifyCustomer(tx, email, {
            customerId,
            eventType: 'PAYMENT_CONFIRMED',
            params: { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' },
          });
          throw new Error('rollback the enclosing business transaction');
        })
      ).rejects.toThrow('rollback the enclosing business transaction');

      const rows = await db.notificationDelivery.findMany({ where: { userId: customerId } });
      expect(rows).toHaveLength(0);
    });
  });

  describe('notifyAdmins', () => {
    it('writes one delivery pair per live staff user holding reservation.cancel', async () => {
      const holder = await seedStaffWithPermission(db, 'reservation.cancel');
      const other = await seedStaffWithPermission(db, 'reservation.cancel');
      await seedPlainStaff(db); // holds nothing, must receive nothing

      await db.$transaction((tx) =>
        notifyAdmins(tx, email, {
          eventType: 'CANCELLATION_REQUESTED',
          params: { reservationCode: 'RM-0001', customerName: 'Erick', reason: 'change of plans' },
        })
      );

      const holderRows = await db.notificationDelivery.findMany({ where: { userId: holder } });
      const otherRows = await db.notificationDelivery.findMany({ where: { userId: other } });
      expect(holderRows).toHaveLength(2);
      expect(otherRows).toHaveLength(2);
    });

    it('never sends to a disabled staff user even if their role grants the permission', async () => {
      const disabled = await seedStaffWithPermission(db, 'reservation.cancel', { status: 'DISABLED' });

      await db.$transaction((tx) =>
        notifyAdmins(tx, email, {
          eventType: 'CANCELLATION_REQUESTED',
          params: { reservationCode: 'RM-0001', customerName: 'Erick', reason: 'change of plans' },
        })
      );

      const rows = await db.notificationDelivery.findMany({ where: { userId: disabled } });
      expect(rows).toHaveLength(0);
    });

    it('writes nothing and does not throw when no staff holds the permission', async () => {
      await seedPlainStaff(db);

      await expect(
        db.$transaction((tx) =>
          notifyAdmins(tx, email, {
            eventType: 'ORPHAN_PAYMENT',
            params: { amount: '$500.00', provider: 'OXXO', intentId: 'pi_123' },
          })
        )
      ).resolves.not.toThrow();

      const rows = await db.notificationDelivery.findMany({});
      expect(rows).toHaveLength(0);
    });
  });

  describe('listInbox', () => {
    it('returns the most recent INBOX deliveries first and never EMAIL deliveries', async () => {
      const customerId = await seedCustomer(db);
      for (let i = 0; i < 3; i += 1) {
        await db.$transaction((tx) =>
          notifyCustomer(tx, email, {
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
      for (let i = 0; i < 5; i += 1) {
        await db.$transaction((tx) =>
          notifyCustomer(tx, email, {
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
  });

  describe('markRead', () => {
    it("marks a customer's own delivery as read", async () => {
      const customerId = await seedCustomer(db);
      await db.$transaction((tx) =>
        notifyCustomer(tx, email, {
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
      await db.$transaction((tx) =>
        notifyCustomer(tx, email, {
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
