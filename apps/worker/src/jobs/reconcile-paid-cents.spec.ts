import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { Db, Reservation } from '@rm/db';
import { reconcilePaidCents } from './reconcile-paid-cents';

const db = withTestDb();

let staffId: string;
let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

async function seedStaffWithPermission(client: Db, permissionKey: string): Promise<string> {
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
      email: `admin-${index}@agency.test`,
      type: 'STAFF',
      status: 'ACTIVE',
      staffProfile: { create: { fullName: `Admin ${index}` } },
    },
  });
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function seedReservation(client: Db, overrides: { paidCents?: number } = {}): Promise<Reservation> {
  const index = next();
  const customer = await client.user.create({
    data: {
      email: `customer-${index}@agency.test`,
      type: 'CUSTOMER',
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
  const trip = await client.trip.create({
    data: {
      slug: `oaxaca-${index}`,
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      createdById: staffId,
    },
  });
  return client.reservation.create({
    data: {
      code: `RM-REC${index}`,
      tripId: trip.id,
      customerId: customer.id,
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: overrides.paidCents ?? 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

async function seedSucceededPayment(client: Db, reservationId: string, amountCents: number): Promise<void> {
  await client.payment.create({
    data: {
      reservationId,
      amountCents,
      method: 'CASH',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      paidAt: new Date(),
    },
  });
}

describe('reconcilePaidCents', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await withTestQueue();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    sequence = 0;
    staffId = (await db.user.create({ data: { email: 'staff@agency.test', type: 'STAFF' } })).id;
  });

  afterAll(async () => {
    await closeTestDb();
    await closeTestQueue();
  });

  it('produces no alert when paid_cents matches the sum of SUCCEEDED payments', async () => {
    const admin = await seedStaffWithPermission(db, 'reservation.cancel');
    const reservation = await seedReservation(db, { paidCents: 150_000 });
    await seedSucceededPayment(db, reservation.id, 100_000);
    await seedSucceededPayment(db, reservation.id, 50_000);
    const boss = await withTestQueue();

    await reconcilePaidCents(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { userId: admin } });
    expect(deliveries).toHaveLength(0);
  });

  it('alerts the admin with both numbers when paid_cents has drifted from the SUCCEEDED total', async () => {
    const admin = await seedStaffWithPermission(db, 'reservation.cancel');
    const reservation = await seedReservation(db, { paidCents: 150_000 });
    await seedSucceededPayment(db, reservation.id, 100_000); // only 100,000 actually succeeded -- paid_cents over-reports by 50,000
    const boss = await withTestQueue();

    await reconcilePaidCents(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { userId: admin } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((row) => row.eventType === 'PAID_CENTS_MISMATCH')).toBe(true);
    expect(deliveries.every((row) => row.reservationId === reservation.id)).toBe(true);
    const inboxRow = deliveries.find((row) => row.channel === 'INBOX');
    expect(inboxRow?.renderedBody).toContain(reservation.code);
  });

  it('subtracts what a price decrease moved to the customer credit (Phase 2B)', async () => {
    const admin = await seedStaffWithPermission(db, 'reservation.cancel');
    // Paid 150,000; a price decrease moved 50,000 of it to the customer's
    // credit, so the reservation now holds 100,000.
    const reservation = await seedReservation(db, { paidCents: 100_000 });
    await seedSucceededPayment(db, reservation.id, 150_000);
    await db.customerCreditEntry.create({
      data: { customerId: reservation.customerId, reservationId: reservation.id, amountCents: 50_000, kind: 'PRICE_DECREASE' },
    });
    // Other kinds tied to the reservation do not move its paid_cents.
    await db.customerCreditEntry.create({
      data: { customerId: reservation.customerId, reservationId: reservation.id, amountCents: 7_000, kind: 'ADJUSTMENT', reason: 'x' },
    });
    const boss = await withTestQueue();

    await reconcilePaidCents(db, boss);

    expect(await db.notificationDelivery.count({ where: { userId: admin } })).toBe(0);
  });

  it('does not correct paid_cents itself -- alerts and stops', async () => {
    const reservation = await seedReservation(db, { paidCents: 150_000 });
    await seedSucceededPayment(db, reservation.id, 100_000);
    const boss = await withTestQueue();

    await reconcilePaidCents(db, boss);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.paidCents).toBe(150_000); // untouched, still wrong
  });

  it('treats a reservation with no payments at all and paid_cents = 0 as matching', async () => {
    const admin = await seedStaffWithPermission(db, 'reservation.cancel');
    await seedReservation(db, { paidCents: 0 });
    const boss = await withTestQueue();

    await reconcilePaidCents(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { userId: admin } });
    expect(deliveries).toHaveLength(0);
  });

  it('ignores PENDING and FAILED payments when summing the real total', async () => {
    const admin = await seedStaffWithPermission(db, 'reservation.cancel');
    const reservation = await seedReservation(db, { paidCents: 100_000 });
    await seedSucceededPayment(db, reservation.id, 100_000);
    await db.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents: 999_999,
        method: 'OXXO',
        status: 'PENDING',
        provider: 'STRIPE',
      },
    });

    const boss = await withTestQueue();
    await reconcilePaidCents(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { userId: admin } });
    expect(deliveries).toHaveLength(0);
  });
});
