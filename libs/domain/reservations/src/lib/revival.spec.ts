import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient, ReservationStatus, Trip } from '@rm/db';
import { createReservation } from './reservation-service';
import { reviveReservationSeat } from './revival';

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;

let staffId: string;
let sequence = 0;

async function seedCustomer(): Promise<string> {
  sequence += 1;
  const user = await db.user.create({
    data: {
      email: `revival-${sequence}@agency.test`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: { fullName: `Cliente ${sequence}`, phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'BRANCH' },
      },
    },
  });
  return user.id;
}

async function seedTrip(overrides: Partial<Pick<Trip, 'totalCapacity' | 'status' | 'holdTtlHours'>> = {}): Promise<Trip> {
  sequence += 1;
  return db.trip.create({
    data: {
      slug: `revival-trip-${sequence}`,
      status: overrides.status ?? 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: overrides.totalCapacity ?? 10,
      preSoldSeats: 0,
      holdTtlHours: overrides.holdTtlHours ?? 48,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staffId,
    },
  });
}

async function seedReservation(
  tripId: string,
  status: ReservationStatus,
  overrides: { customerId?: string; holdExpiresAt?: Date | null } = {}
) {
  sequence += 1;
  const customerId = overrides.customerId ?? (await seedCustomer());
  return db.reservation.create({
    data: {
      code: `RM-REV${sequence}`,
      tripId,
      customerId,
      status,
      holdExpiresAt:
        overrides.holdExpiresAt === undefined ? (status === 'HELD' ? new Date(Date.now() + HOUR_MS) : null) : overrides.holdExpiresAt,
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: new Date('2027-11-01'),
      source: 'BRANCH',
    },
  });
}

const revive = (reservationId: string) =>
  db.$transaction((tx: DbTransactionClient) => reviveReservationSeat(tx, { reservationId, actorId: staffId }));

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  sequence = 0;
  staffId = (await db.user.create({ data: { email: 'staff@agency.test', type: 'STAFF' } })).id;
});

afterAll(async () => {
  await closeTestDb();
});

describe('reviveReservationSeat', () => {
  it('leaves a live reservation alone and says so', async () => {
    const trip = await seedTrip();
    const held = await seedReservation(trip.id, 'HELD');
    const active = await seedReservation(trip.id, 'ACTIVE');

    expect(await revive(held.id)).toMatchObject({ ok: true, value: { outcome: 'LIVE' } });
    expect(await revive(active.id)).toMatchObject({ ok: true, value: { outcome: 'LIVE' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: held.id } })).holdExpiresAt).toEqual(held.holdExpiresAt);
    expect(await db.auditLog.count({ where: { action: 'reservation.revived' } })).toBe(0);
  });

  it('revives an EXPIRED reservation as HELD with a fresh hold of the trip\'s own length, and audits it', async () => {
    const trip = await seedTrip({ holdTtlHours: 24 });
    const expired = await seedReservation(trip.id, 'EXPIRED');
    const before = Date.now();

    const result = await revive(expired.id);

    expect(result).toMatchObject({ ok: true, value: { outcome: 'REVIVED', previousStatus: 'EXPIRED' } });
    const after = await db.reservation.findUniqueOrThrow({ where: { id: expired.id } });
    expect(after.status).toBe('HELD');
    expect(after.holdExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR_MS);
    expect(after.holdExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS);
    expect(await db.auditLog.count({ where: { action: 'reservation.revived', entityId: expired.id, actorUserId: staffId } })).toBe(1);
  });

  it('revives a HELD reservation whose time already ran out, before the job has expired it', async () => {
    const trip = await seedTrip();
    const stale = await seedReservation(trip.id, 'HELD', { holdExpiresAt: new Date(Date.now() - HOUR_MS) });

    expect(await revive(stale.id)).toMatchObject({ ok: true, value: { outcome: 'REVIVED', previousStatus: 'HELD' } });
    const after = await db.reservation.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.status).toBe('HELD');
    expect(after.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a CANCELLED reservation', async () => {
    const trip = await seedTrip();
    const cancelled = await seedReservation(trip.id, 'CANCELLED');

    expect(await revive(cancelled.id)).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe('CANCELLED');
  });

  it('is TRIP_SOLD_OUT when the seat was given to someone else, and writes nothing', async () => {
    const trip = await seedTrip({ totalCapacity: 1 });
    const expired = await seedReservation(trip.id, 'EXPIRED');
    await seedReservation(trip.id, 'ACTIVE');

    expect(await revive(expired.id)).toMatchObject({ ok: false, error: { code: 'TRIP_SOLD_OUT' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('EXPIRED');
    expect(await db.auditLog.count({ where: { action: 'reservation.revived' } })).toBe(0);
  });

  it('is TRIP_NOT_PUBLISHED when the trip is no longer on sale', async () => {
    const trip = await seedTrip({ status: 'CANCELLED' });
    const expired = await seedReservation(trip.id, 'EXPIRED');

    expect(await revive(expired.id)).toMatchObject({ ok: false, error: { code: 'TRIP_NOT_PUBLISHED' } });
  });

  it('is DUPLICATE_RESERVATION when the customer booked the trip again in the meantime', async () => {
    const trip = await seedTrip();
    const customerId = await seedCustomer();
    const expired = await seedReservation(trip.id, 'EXPIRED', { customerId });
    await seedReservation(trip.id, 'HELD', { customerId });

    expect(await revive(expired.id)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RESERVATION' } });
    expect((await db.reservation.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('EXPIRED');
  });

  it('is NOT_FOUND for an unknown or malformed id', async () => {
    expect(await revive('00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await revive('not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('gives the last seat to exactly one of two expired reservations revived at once, 30 times over', async () => {
    for (let i = 0; i < 30; i++) {
      const trip = await seedTrip({ totalCapacity: 1 });
      const first = await seedReservation(trip.id, 'EXPIRED');
      const second = await seedReservation(trip.id, 'EXPIRED');

      const results = await Promise.all([revive(first.id), revive(second.id)]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'TRIP_SOLD_OUT' } });
      const live = await db.reservation.count({ where: { tripId: trip.id, status: 'HELD' } });
      expect(live).toBe(1);
    }
  });

  it('and so does a revival racing a brand new booking for the last seat, 30 times over', async () => {
    for (let i = 0; i < 30; i++) {
      const trip = await seedTrip({ totalCapacity: 1 });
      const expired = await seedReservation(trip.id, 'EXPIRED');
      const newcomer = await seedCustomer();
      await db.user.update({ where: { id: newcomer }, data: { emailVerifiedAt: new Date() } });

      const [revived, booked] = await Promise.all([
        revive(expired.id),
        createReservation(db, { tripId: trip.id, customerId: newcomer }),
      ]);

      expect([revived.ok, booked.ok].filter(Boolean)).toHaveLength(1);
      expect(await db.reservation.count({ where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } } })).toBe(1);
    }
  });
});
