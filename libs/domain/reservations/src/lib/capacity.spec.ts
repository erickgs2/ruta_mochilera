import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient } from '@rm/db';
import { availableSeats } from '@rm/domain-trips';
import { fail, ok, type Result } from '@rm/shared-utils';
import { countCommittedSeats, countCommittedSeatsForTrips, lockTripForCapacity } from './capacity';

const db = withTestDb();

const HOUR_MS = 60 * 60 * 1000;

/** Gives the other transaction time to reach the row lock before this one commits. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let staffId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

async function seedTrip(
  db: Db,
  overrides: { totalCapacity?: number; preSoldSeats?: number } = {}
) {
  return db.trip.create({
    data: {
      slug: `oaxaca-${next()}`,
      status: 'PUBLISHED',
      departureDate: new Date('2026-12-01'),
      returnDate: new Date('2026-12-07'),
      paymentDeadline: new Date('2026-11-01'),
      totalCapacity: overrides.totalCapacity ?? 20,
      preSoldSeats: overrides.preSoldSeats ?? 0,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      createdById: staffId,
    },
  });
}

async function seedCustomers(db: Db, count: number) {
  const customers = [];
  for (let index = 0; index < count; index++) {
    customers.push(
      await db.user.create({
        data: {
          email: `customer-${next()}@agency.test`,
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
      })
    );
  }
  return customers;
}

async function seedReservation(
  db: Db,
  input: {
    tripId: string;
    customerId: string;
    status: 'HELD' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
    holdExpiresAt?: Date;
  }
) {
  return db.reservation.create({
    data: {
      code: `RES-${next().toString().padStart(4, '0')}`,
      tripId: input.tripId,
      customerId: input.customerId,
      status: input.status,
      holdExpiresAt: input.holdExpiresAt ?? null,
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: new Date('2026-11-01'),
      source: 'APP',
    },
  });
}

/** A promise plus the handle that settles it, used to pin down an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/**
 * The seat-claiming sequence the three primitives of this file are meant to be
 * composed into: lock the trip row **first**, then count, then decide, then
 * insert. It lives in the spec rather than in `src/` because the real entry
 * point -- `createReservation`, with its published / payment-deadline /
 * duplicate / verified-email rules and its folio generation -- belongs to the
 * next task; what this task owns is the primitives and the order.
 *
 * `beforeInsert` lets a test hold one transaction open after it has taken the
 * lock and read its count, which is what turns the contention tests below from
 * a coin flip into a decision about the lock. Without it the two attempts race
 * on this machine's timings and the first one tends to commit before the
 * second even reads -- the sequential interleaving that passes with no lock at
 * all.
 */
async function claimSeat(
  db: Db,
  input: { tripId: string; customerId: string; beforeInsert?: () => Promise<void> }
): Promise<Result<{ id: string }>> {
  return db.$transaction(async (tx: DbTransactionClient) => {
    await lockTripForCapacity(tx, input.tripId);

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: input.tripId } });
    const committed = await countCommittedSeats(tx, input.tripId);
    const seats = availableSeats({
      totalCapacity: trip.totalCapacity,
      preSoldSeats: trip.preSoldSeats,
      ...committed,
    });
    if (seats < 1) return fail('TRIP_SOLD_OUT');

    if (input.beforeInsert) await input.beforeInsert();

    const reservation = await tx.reservation.create({
      data: {
        code: `RES-${input.customerId.slice(0, 8)}`,
        tripId: input.tripId,
        customerId: input.customerId,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() + trip.holdTtlHours * HOUR_MS),
        totalPriceCents: trip.pricePerSeatCents,
        minimumDepositCents: trip.minimumDepositCents,
        paymentDeadline: trip.paymentDeadline,
        source: 'APP',
      },
    });
    return ok({ id: reservation.id });
  });
}

describe('capacity', () => {
  beforeAll(() => prepareTestDb());

  beforeEach(async () => {
    await resetDatabase(db);
    sequence = 0;
    const staff = await db.user.create({
      data: {
        email: 'staff@agency.test',
        type: 'STAFF',
        staffProfile: { create: { fullName: 'Staff' } },
      },
    });
    staffId = staff.id;
  });

  afterAll(() => closeTestDb());

  describe('countCommittedSeats', () => {
    it('reports zeros for a trip nobody has booked', async () => {
      const trip = await seedTrip(db);

      expect(await countCommittedSeats(db, trip.id)).toEqual({
        activeReservations: 0,
        liveHolds: 0,
      });
    });

    it('counts ACTIVE reservations and holds that have not expired yet', async () => {
      const trip = await seedTrip(db);
      const [first, second, third] = await seedCustomers(db, 3);

      await seedReservation(db, { tripId: trip.id, customerId: first.id, status: 'ACTIVE' });
      await seedReservation(db, {
        tripId: trip.id,
        customerId: second.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() + HOUR_MS),
      });
      await seedReservation(db, {
        tripId: trip.id,
        customerId: third.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() + 2 * HOUR_MS),
      });

      expect(await countCommittedSeats(db, trip.id)).toEqual({
        activeReservations: 1,
        liveHolds: 2,
      });
    });

    it('ignores a HELD reservation whose hold already expired', async () => {
      const trip = await seedTrip(db);
      const [customer] = await seedCustomers(db, 1);

      await seedReservation(db, {
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() - HOUR_MS),
      });

      expect(await countCommittedSeats(db, trip.id)).toEqual({
        activeReservations: 0,
        liveHolds: 0,
      });
    });

    it('ignores CANCELLED and EXPIRED reservations', async () => {
      const trip = await seedTrip(db);
      const [first, second] = await seedCustomers(db, 2);

      await seedReservation(db, { tripId: trip.id, customerId: first.id, status: 'CANCELLED' });
      await seedReservation(db, { tripId: trip.id, customerId: second.id, status: 'EXPIRED' });

      expect(await countCommittedSeats(db, trip.id)).toEqual({
        activeReservations: 0,
        liveHolds: 0,
      });
    });

    it('ignores reservations that belong to another trip', async () => {
      const trip = await seedTrip(db);
      const other = await seedTrip(db);
      const [customer] = await seedCustomers(db, 1);

      await seedReservation(db, { tripId: other.id, customerId: customer.id, status: 'ACTIVE' });

      expect(await countCommittedSeats(db, trip.id)).toEqual({
        activeReservations: 0,
        liveHolds: 0,
      });
    });
  });

  describe('countCommittedSeatsForTrips', () => {
    it('splits the counts per trip', async () => {
      const first = await seedTrip(db);
      const second = await seedTrip(db);
      const [one, two, three] = await seedCustomers(db, 3);

      await seedReservation(db, { tripId: first.id, customerId: one.id, status: 'ACTIVE' });
      await seedReservation(db, {
        tripId: first.id,
        customerId: two.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() + HOUR_MS),
      });
      await seedReservation(db, { tripId: second.id, customerId: three.id, status: 'ACTIVE' });

      const counts = await countCommittedSeatsForTrips(db, [first.id, second.id]);

      expect(counts.get(first.id)).toEqual({ activeReservations: 1, liveHolds: 1 });
      expect(counts.get(second.id)).toEqual({ activeReservations: 1, liveHolds: 0 });
    });

    it('includes a trip with no reservations as zeros instead of leaving it out', async () => {
      const booked = await seedTrip(db);
      const empty = await seedTrip(db);
      const [customer] = await seedCustomers(db, 1);
      await seedReservation(db, { tripId: booked.id, customerId: customer.id, status: 'ACTIVE' });

      const counts = await countCommittedSeatsForTrips(db, [booked.id, empty.id]);

      // A caller reaching for `counts.get(id)!` on a trip nobody has booked
      // must not blow up on a missing entry.
      expect(counts.has(empty.id)).toBe(true);
      expect(counts.get(empty.id)).toEqual({ activeReservations: 0, liveHolds: 0 });
    });

    it('returns an empty map for an empty list of trips', async () => {
      expect(await countCommittedSeatsForTrips(db, [])).toEqual(new Map());
    });
  });

  describe('the last seat under contention', () => {
    it('lets exactly one of two concurrent reservations take the last seat', async () => {
      const trip = await seedTrip(db, { totalCapacity: 1, preSoldSeats: 0 });
      const [a, b] = await seedCustomers(db, 2);

      const firstHasRead = deferred();
      const firstMayInsert = deferred();

      // Both attempts are in flight before either is awaited. The first one
      // stops with its lock held and its count already read; the second then
      // runs the whole read-decide-insert sequence into that open window --
      // precisely the interleaving that oversells a trip when nothing holds
      // the row. With the lock in place the second attempt blocks on
      // `SELECT ... FOR UPDATE` until the first commits, and the count it
      // then reads already includes the first one's seat.
      const first = claimSeat(db, {
        tripId: trip.id,
        customerId: a.id,
        beforeInsert: async () => {
          firstHasRead.resolve();
          await firstMayInsert.promise;
        },
      });
      const second = (async () => {
        await firstHasRead.promise;
        return claimSeat(db, { tripId: trip.id, customerId: b.id });
      })();

      // Long enough for the second attempt to reach the row lock (a BEGIN and
      // one statement). It is not load-bearing: too short and the second
      // attempt simply queues behind a lock that has already been released,
      // reads the committed seat and is still rejected.
      await settle(200);
      firstMayInsert.resolve();

      const results = await Promise.all([first, second]);

      const succeeded = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const rejected = failed[0];
      if (rejected && !rejected.ok) expect(rejected.error.code).toBe('TRIP_SOLD_OUT');

      const live = await db.reservation.count({
        where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } },
      });
      expect(live).toBe(1);
    });

    it('does not make a reservation for another trip wait on that lock', async () => {
      const locked = await seedTrip(db, { totalCapacity: 1 });
      const other = await seedTrip(db, { totalCapacity: 1 });
      const [a, b] = await seedCustomers(db, 2);

      const lockHeld = deferred();
      const releaseLock = deferred();

      const holder = claimSeat(db, {
        tripId: locked.id,
        customerId: a.id,
        beforeInsert: async () => {
          lockHeld.resolve();
          await releaseLock.promise;
        },
      });

      // Completed while the other transaction still holds its lock: this is
      // the assertion that `FOR UPDATE` took a row and not the table. A table
      // lock would leave this await hanging until Prisma's transaction
      // timeout.
      await lockHeld.promise;
      const unrelated = await claimSeat(db, { tripId: other.id, customerId: b.id });
      expect(unrelated.ok).toBe(true);

      releaseLock.resolve();
      expect((await holder).ok).toBe(true);
    });
  });
});
