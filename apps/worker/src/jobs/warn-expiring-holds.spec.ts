import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { Db, Reservation, ReservationStatus } from '@rm/db';
import { warnExpiringHolds } from './warn-expiring-holds';

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;

let staffId: string;
let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

async function seedCustomer(client: Db): Promise<string> {
  const index = next();
  const user = await client.user.create({
    data: {
      email: `customer-${index}@agency.test`,
      type: 'CUSTOMER',
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

async function seedReservation(
  client: Db,
  overrides: {
    status?: ReservationStatus;
    minimumDepositCents?: number;
    paidCents?: number;
    holdExpiresAt?: Date | null;
    holdTtlHours?: number;
    customerId?: string;
  } = {}
): Promise<Reservation> {
  const index = next();
  const customerId = overrides.customerId ?? (await seedCustomer(client));
  const holdTtlHours = overrides.holdTtlHours ?? 72;
  const trip = await client.trip.create({
    data: {
      slug: `oaxaca-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      holdTtlHours,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      createdById: staffId,
    },
  });
  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-WRN${index}`,
      tripId: trip.id,
      customerId,
      status,
      holdExpiresAt:
        overrides.holdExpiresAt === undefined
          ? status === 'HELD'
            ? new Date(Date.now() + holdTtlHours * HOUR_MS)
            : null
          : overrides.holdExpiresAt,
      totalPriceCents: 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paidCents: overrides.paidCents ?? 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

describe('warnExpiringHolds', () => {
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

  it('warns once a 72-hour hold has less than a quarter of its term left', async () => {
    const reservation = await seedReservation(db, {
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 10 * HOUR_MS), // < 18h quarter
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((row) => row.eventType === 'HOLD_EXPIRING')).toBe(true);
  });

  it('does not warn a 72-hour hold with more than a quarter of its term left', async () => {
    const reservation = await seedReservation(db, {
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 60 * HOUR_MS), // way over the 18h threshold
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(0);
  });

  it('does not warn a 6-hour hold the instant it is created, because the floor is one hour, not a quarter', async () => {
    // A 6-hour trip's quarter is 1.5h, which is still above the 1h floor, so
    // the floor never kicks in here -- this is the brief's own example: at
    // the moment of booking (6h remaining), 6h > 1.5h, so no warning yet.
    const reservation = await seedReservation(db, {
      holdTtlHours: 6,
      holdExpiresAt: new Date(Date.now() + 6 * HOUR_MS),
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(0);
  });

  it('does warn a 6-hour hold once inside its 1.5-hour quarter', async () => {
    const reservation = await seedReservation(db, {
      holdTtlHours: 6,
      holdExpiresAt: new Date(Date.now() + 1 * HOUR_MS),
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(2);
  });

  it('does not warn the same reservation twice', async () => {
    const reservation = await seedReservation(db, {
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 10 * HOUR_MS),
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);
    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(2); // one EMAIL + one INBOX, not four
  });

  it('does not warn a reservation that has already reached its minimum deposit', async () => {
    const reservation = await seedReservation(db, {
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 10 * HOUR_MS),
      minimumDepositCents: 100_000,
      paidCents: 100_000,
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(0);
  });

  it('never warns about an ACTIVE or already-EXPIRED reservation', async () => {
    const active = await seedReservation(db, { status: 'ACTIVE', holdExpiresAt: null });
    const expired = await seedReservation(db, {
      status: 'EXPIRED',
      holdExpiresAt: new Date(Date.now() - HOUR_MS),
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({
      where: { reservationId: { in: [active.id, expired.id] } },
    });
    expect(deliveries).toHaveLength(0);
  });

  it('warns two different reservations of the same customer independently', async () => {
    const customerId = await seedCustomer(db);
    const soon = await seedReservation(db, {
      customerId,
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 10 * HOUR_MS),
    });
    const notSoon = await seedReservation(db, {
      customerId,
      holdTtlHours: 72,
      holdExpiresAt: new Date(Date.now() + 60 * HOUR_MS),
    });
    const boss = await withTestQueue();

    await warnExpiringHolds(db, boss);

    const soonDeliveries = await db.notificationDelivery.findMany({ where: { reservationId: soon.id } });
    const notSoonDeliveries = await db.notificationDelivery.findMany({ where: { reservationId: notSoon.id } });
    expect(soonDeliveries).toHaveLength(2);
    expect(notSoonDeliveries).toHaveLength(0);
  });
});
