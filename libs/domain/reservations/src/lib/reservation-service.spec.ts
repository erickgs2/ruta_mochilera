import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient } from '@rm/db';
import type { NotificationQueue } from '@rm/domain-notifications';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { availableSeats, countCommittedSeats } from './capacity';
import {
  cancelReservation,
  createReservation,
  getReservationForCustomer,
  getReservationForStaff,
  listReservationsForCustomer,
  listReservationsForStaff,
  requestCancellation,
} from './reservation-service';

const db = withTestDb();

const HOUR_MS = 60 * 60 * 1000;

/** Gives the other transaction time to reach the row lock before this one commits. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus the handle that settles it, used to pin down an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

let staffId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

async function seedTrip(
  db: Db,
  overrides: {
    status?: 'DRAFT' | 'PUBLISHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
    totalCapacity?: number;
    preSoldSeats?: number;
    holdTtlHours?: number;
    pricePerSeatCents?: number;
    minimumDepositCents?: number;
    paymentDeadline?: Date;
  } = {}
) {
  return db.trip.create({
    data: {
      slug: `oaxaca-${next()}`,
      status: overrides.status ?? 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: overrides.paymentDeadline ?? new Date('2027-11-01'),
      totalCapacity: overrides.totalCapacity ?? 20,
      preSoldSeats: overrides.preSoldSeats ?? 0,
      holdTtlHours: overrides.holdTtlHours ?? 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.pricePerSeatCents ?? 500_000,
      createdById: staffId,
    },
  });
}

/**
 * A STAFF user holding `reservation.cancel` -- `notifyAdmins` routes every
 * staff-only alert (including `CANCELLATION_REQUESTED`) to whoever holds
 * exactly this permission (`ADMIN_ALERT_PERMISSION` in
 * `delivery-service.ts`). Mirrors `seedAdmin` in
 * `payment-service`'s sibling `webhook-handler.spec.ts`.
 */
async function seedAdmin(db: Db): Promise<string> {
  const permission = await db.permission.create({
    data: { key: 'reservation.cancel', category: 'reservations', description: 'Cancel reservations' },
  });
  const role = await db.role.create({ data: { name: `agent-${next()}`, description: 'Front desk' } });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const user = await db.user.create({
    data: {
      email: `agent-${next()}@agency.test`,
      type: 'STAFF',
      staffProfile: { create: { fullName: 'Agente' } },
      roles: { create: { roleId: role.id } },
    },
  });
  return user.id;
}

async function seedCustomer(db: Db, overrides: { emailVerified?: boolean } = {}) {
  const index = next();
  const user = await db.user.create({
    data: {
      email: `customer-${index}@agency.test`,
      type: 'CUSTOMER',
      emailVerifiedAt: overrides.emailVerified === false ? null : new Date(),
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

async function setOrganizationTimeZone(db: Db, timeZone: string) {
  await db.systemSetting.upsert({
    where: { key: 'organization.timezone' },
    create: { key: 'organization.timezone', value: timeZone },
    update: { value: timeZone },
  });
}

/**
 * Wraps a real client so that the reservation INSERT inside
 * `createReservation`'s transaction waits on `pause` before it runs.
 *
 * The contention test needs one attempt parked *after* it has taken the trip's
 * row lock and read its count, but *before* it inserts -- the window that
 * oversells when nothing holds the row. `createReservation` deliberately has
 * no hook for that (a test seam in production code would be the thing under
 * test), so the seam is the injected client it already takes: the proxy is
 * transparent for everything except the one call whose timing the test is
 * about.
 */
function clientPausingBeforeInsert(db: Db, pause: () => Promise<void>): Db {
  const forward = (target: object, property: string | symbol) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };

  const pausingTransactionClient = (tx: DbTransactionClient): DbTransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        if (property !== 'reservation') return forward(target, property);
        const reservations = Reflect.get(target, property) as DbTransactionClient['reservation'];
        return new Proxy(reservations, {
          get(delegate, operation) {
            if (operation !== 'create') return forward(delegate, operation);
            return async (...args: Parameters<DbTransactionClient['reservation']['create']>) => {
              await pause();
              return delegate.create(...args);
            };
          },
        });
      },
    }) as DbTransactionClient;

  return new Proxy(db, {
    get(target, property) {
      if (property !== '$transaction') return forward(target, property);
      return (run: (tx: DbTransactionClient) => Promise<unknown>) =>
        target.$transaction((tx) => run(pausingTransactionClient(tx)));
    },
  }) as Db;
}

let queue: NotificationQueue;

describe('reservation service', () => {
  beforeAll(async () => {
    await prepareTestDb();
    queue = await withTestQueue();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
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

  afterAll(async () => {
    await closeTestDb();
    await closeTestQueue();
  });

  describe('createReservation', () => {
    it('creates a HELD reservation with the trip price frozen into it', async () => {
      const trip = await seedTrip(db, { pricePerSeatCents: 500_000, minimumDepositCents: 100_000 });
      const customerId = await seedCustomer(db);

      const created = await createReservation(db, { tripId: trip.id, customerId });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.status).toBe('HELD');
      expect(created.value.totalPriceCents).toBe(500_000);
      expect(created.value.minimumDepositCents).toBe(100_000);
      expect(created.value.paidCents).toBe(0);
      expect(created.value.creditCents).toBe(0);
      expect(created.value.balanceCents).toBe(500_000);
      expect(created.value.cancellationRequestedAt).toBeNull();
      expect(created.value.code).toMatch(/^RM-/);

      // The price is a copy, not a reference: repricing the trip afterwards
      // leaves every existing reservation on the amount its customer agreed to.
      await db.trip.update({ where: { id: trip.id }, data: { pricePerSeatCents: 900_000 } });

      const reread = await getReservationForCustomer(db, created.value.id, customerId);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.totalPriceCents).toBe(500_000);
    });

    it('derives the hold expiry from the trip hold_ttl_hours, not from a constant', async () => {
      const trip = await seedTrip(db, { holdTtlHours: 5 });
      const customerId = await seedCustomer(db);

      const before = Date.now();
      const created = await createReservation(db, { tripId: trip.id, customerId });
      const after = Date.now();

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const expiry = created.value.holdExpiresAt?.getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 5 * HOUR_MS);
      expect(expiry).toBeLessThanOrEqual(after + 5 * HOUR_MS);
    });

    it('writes an audit entry inside the same transaction as the reservation', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);

      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const entries = await db.auditLog.findMany({ where: { entityId: created.value.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('reservation.created');
      expect(entries[0]?.entityType).toBe('Reservation');
      expect(entries[0]?.actorUserId).toBe(customerId);
    });

    it.each(['DRAFT', 'CANCELLED'] as const)('refuses a trip in %s', async (status) => {
      const trip = await seedTrip(db, { status });
      const customerId = await seedCustomer(db);

      const created = await createReservation(db, { tripId: trip.id, customerId });

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('TRIP_NOT_PUBLISHED');
      expect(await db.reservation.count()).toBe(0);
    });

    it('refuses a trip whose payment deadline is already past in the organization timezone', async () => {
      // Pacific/Kiritimati (UTC+14) and Pacific/Midway (UTC-11) are 25 hours
      // apart, so they are never on the same calendar day. A deadline falling
      // on Midway's today is therefore already yesterday in Kiritimati --
      // which makes this pair of tests a statement about *which* zone the rule
      // reads, not about the machine's clock.
      const deadline = DateTime.now().setZone('Pacific/Midway').toISODate();
      await setOrganizationTimeZone(db, 'Pacific/Kiritimati');
      const trip = await seedTrip(db, { paymentDeadline: new Date(`${deadline}T00:00:00Z`) });
      const customerId = await seedCustomer(db);

      const created = await createReservation(db, { tripId: trip.id, customerId });

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('PAYMENT_DEADLINE_PASSED');
    });

    it('accepts that same deadline when the organization sits in the zone it is still today in', async () => {
      const deadline = DateTime.now().setZone('Pacific/Midway').toISODate();
      await setOrganizationTimeZone(db, 'Pacific/Midway');
      const trip = await seedTrip(db, { paymentDeadline: new Date(`${deadline}T00:00:00Z`) });
      const customerId = await seedCustomer(db);

      const created = await createReservation(db, { tripId: trip.id, customerId });

      expect(created.ok).toBe(true);
    });

    it('refuses a second live reservation by the same customer on the same trip', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      expect((await createReservation(db, { tripId: trip.id, customerId })).ok).toBe(true);

      const second = await createReservation(db, { tripId: trip.id, customerId });

      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('DUPLICATE_RESERVATION');
      expect(await db.reservation.count()).toBe(1);
    });

    it('lets the same customer reserve again once the previous reservation is cancelled', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const first = await createReservation(db, { tripId: trip.id, customerId });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await db.reservation.update({
        where: { id: first.value.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      const second = await createReservation(db, { tripId: trip.id, customerId });

      expect(second.ok).toBe(true);
      expect(await db.reservation.count()).toBe(2);
    });

    it('refuses a customer whose email is not verified', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db, { emailVerified: false });

      const created = await createReservation(db, { tripId: trip.id, customerId });

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await db.reservation.count()).toBe(0);
    });

    it('refuses when the trip has no seats left', async () => {
      const trip = await seedTrip(db, { totalCapacity: 1 });
      expect(
        (await createReservation(db, { tripId: trip.id, customerId: await seedCustomer(db) })).ok
      ).toBe(true);

      const second = await createReservation(db, {
        tripId: trip.id,
        customerId: await seedCustomer(db),
      });

      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('TRIP_SOLD_OUT');
    });

    it('counts pre-sold seats against the capacity', async () => {
      const trip = await seedTrip(db, { totalCapacity: 2, preSoldSeats: 2 });

      const created = await createReservation(db, {
        tripId: trip.id,
        customerId: await seedCustomer(db),
      });

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('TRIP_SOLD_OUT');
    });

    it('reports an unknown trip and an unknown customer as NOT_FOUND', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const absent = '11111111-1111-1111-1111-111111111111';

      const noTrip = await createReservation(db, { tripId: absent, customerId });
      const noCustomer = await createReservation(db, { tripId: trip.id, customerId: absent });

      expect(noTrip.ok).toBe(false);
      if (!noTrip.ok) expect(noTrip.error.code).toBe('NOT_FOUND');
      expect(noCustomer.ok).toBe(false);
      if (!noCustomer.ok) expect(noCustomer.error.code).toBe('NOT_FOUND');
    });

    it('gives fifty reservations fifty different codes', async () => {
      const trip = await seedTrip(db, { totalCapacity: 50 });
      const codes = new Set<string>();

      for (let index = 0; index < 50; index++) {
        const created = await createReservation(db, {
          tripId: trip.id,
          customerId: await seedCustomer(db),
        });
        expect(created.ok).toBe(true);
        if (created.ok) codes.add(created.value.code);
      }

      expect(codes.size).toBe(50);
    });

    it('lets exactly one of two concurrent reservations take the last seat', async () => {
      const trip = await seedTrip(db, { totalCapacity: 1 });
      const [a, b] = [await seedCustomer(db), await seedCustomer(db)];

      const firstHasRead = deferred();
      const firstMayInsert = deferred();
      const pausing = clientPausingBeforeInsert(db, async () => {
        firstHasRead.resolve();
        await firstMayInsert.promise;
      });

      // Both attempts are in flight before either is awaited. The first one
      // stops with its lock held and its count already read; the second then
      // runs the whole read-decide-insert sequence into that open window --
      // precisely the interleaving that oversells a trip when nothing holds
      // the row. A plain `Promise.all` of two attempts proves nothing here:
      // on this machine the first transaction commits before the second even
      // counts, so it passes with no lock at all.
      const first = createReservation(pausing, { tripId: trip.id, customerId: a });
      const second = (async () => {
        await firstHasRead.promise;
        return createReservation(db, { tripId: trip.id, customerId: b });
      })();

      // Long enough for the second attempt to reach the row lock (a BEGIN and
      // one statement). It is not load-bearing: too short and the second
      // attempt simply queues behind a lock that has already been released,
      // reads the committed seat and is still rejected.
      await settle(200);
      firstMayInsert.resolve();

      const results = await Promise.all([first, second]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const rejected = results.find((result) => !result.ok);
      if (rejected && !rejected.ok) expect(rejected.error.code).toBe('TRIP_SOLD_OUT');

      const live = await db.reservation.count({
        where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } },
      });
      expect(live).toBe(1);
    });
  });

  describe('getReservationForCustomer', () => {
    it('returns the reservation with its outstanding balance', async () => {
      const trip = await seedTrip(db, { pricePerSeatCents: 500_000 });
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await db.reservation.update({
        where: { id: created.value.id },
        data: { paidCents: 120_000 },
      });

      const found = await getReservationForCustomer(db, created.value.id, customerId);

      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.paidCents).toBe(120_000);
      expect(found.value.balanceCents).toBe(380_000);
      expect(found.value.tripId).toBe(trip.id);
      expect(found.value.customerId).toBe(customerId);
    });

    it('refuses another customer reservation without revealing anything about its owner', async () => {
      const trip = await seedTrip(db);
      const owner = await seedCustomer(db);
      const stranger = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId: owner });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const found = await getReservationForCustomer(db, created.value.id, stranger);

      expect(found.ok).toBe(false);
      if (found.ok) return;
      expect(found.error.code).toBe('RESERVATION_NOT_OWNED');
      // Nothing about the real owner travels back: no details at all, and in
      // particular not their id, the reservation's code or its trip.
      expect(found.error.details).toBeUndefined();
      expect(JSON.stringify(found.error)).not.toContain(owner);
      expect(JSON.stringify(found.error)).not.toContain(created.value.code);
    });

    it('answers an id that does not exist exactly as it answers one that is not yours', async () => {
      const stranger = await seedCustomer(db);

      const missing = await getReservationForCustomer(
        db,
        '11111111-1111-1111-1111-111111111111',
        stranger
      );

      // Same code, same details, same HTTP status: a customer walking ids
      // cannot tell "this reservation is someone else's" from "there is no
      // such reservation", which is the whole point of not answering 403.
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('RESERVATION_NOT_OWNED');
    });
  });

  describe('listReservationsForCustomer', () => {
    it('lists only that customer reservations, newest first', async () => {
      const [first, second] = [await seedTrip(db), await seedTrip(db)];
      const customerId = await seedCustomer(db);
      const other = await seedCustomer(db);
      const older = await createReservation(db, { tripId: first.id, customerId });
      const newer = await createReservation(db, { tripId: second.id, customerId });
      await createReservation(db, { tripId: first.id, customerId: other });
      expect(older.ok && newer.ok).toBe(true);
      if (!older.ok || !newer.ok) return;

      const listed = await listReservationsForCustomer(db, customerId);

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.map((reservation) => reservation.id)).toEqual([
        newer.value.id,
        older.value.id,
      ]);
      expect(listed.value[0]?.balanceCents).toBe(500_000);
    });

    it("names each row's trip from its Spanish translation, like the public summary, plus its departure date", async () => {
      const named = await seedTrip(db);
      await db.tripTranslation.createMany({
        data: [
          { tripId: named.id, locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
          { tripId: named.id, locale: 'en', name: 'Magic Oaxaca', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
        ],
      });
      const unnamed = await seedTrip(db);
      const customerId = await seedCustomer(db);
      await createReservation(db, { tripId: named.id, customerId });
      await createReservation(db, { tripId: unnamed.id, customerId });

      const listed = await listReservationsForCustomer(db, customerId);

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const byTrip = new Map(listed.value.map((row) => [row.tripId, row]));
      expect(byTrip.get(named.id)?.tripName).toBe('Oaxaca Mágica');
      expect(byTrip.get(named.id)?.tripDepartureDate.toISOString().slice(0, 10)).toBe('2027-12-01');
      // No Spanish translation: the slug, never an invented name -- same fallback as the public summary.
      expect(byTrip.get(unnamed.id)?.tripName).toBe(unnamed.slug);
    });

    it('returns an empty list for a customer who has never reserved', async () => {
      const listed = await listReservationsForCustomer(db, await seedCustomer(db));

      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.value).toEqual([]);
    });
  });

  describe('requestCancellation', () => {
    it('seals the request without touching the status or the running hold', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const requested = await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');

      expect(requested.ok).toBe(true);
      if (!requested.ok) return;
      expect(requested.value.status).toBe('HELD');
      expect(requested.value.cancellationRequestedAt).toBeInstanceOf(Date);
      expect(requested.value.holdExpiresAt).toEqual(created.value.holdExpiresAt);

      const stored = await db.reservation.findUniqueOrThrow({ where: { id: created.value.id } });
      expect(stored.cancellationReason).toBe('Me enfermé');
      // A request is not a cancellation: no money moves and no seat is freed
      // until a person decides (spec 5.6).
      expect(stored.cancelledAt).toBeNull();
      expect(stored.cancelledById).toBeNull();
      const committed = await db.reservation.count({
        where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } },
      });
      expect(committed).toBe(1);
    });

    it('notifies every staff member holding reservation.cancel, once', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const adminId = await seedAdmin(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const requested = await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');

      expect(requested.ok).toBe(true);
      // One EMAIL row and one INBOX row, same pair every `notifyAdmins` call
      // writes (delivery-service.ts) -- addressed to the staff member
      // holding `reservation.cancel`, never to the customer who asked.
      const deliveries = await db.notificationDelivery.findMany({
        where: { userId: adminId, eventType: 'CANCELLATION_REQUESTED' },
      });
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'INBOX']);
      expect(deliveries[0]?.reservationId).toBe(created.value.id);
      expect(deliveries.every((d) => d.renderedBody.includes(created.value.code))).toBe(true);
      const customerDeliveries = await db.notificationDelivery.count({ where: { userId: customerId } });
      expect(customerDeliveries).toBe(0);
    });

    it('does not notify twice when the customer asks twice', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const adminId = await seedAdmin(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');
      await requestCancellation(db, created.value.id, customerId, queue, 'Otro motivo');

      const deliveries = await db.notificationDelivery.count({
        where: { userId: adminId, eventType: 'CANCELLATION_REQUESTED' },
      });
      expect(deliveries).toBe(2);
    });

    it('keeps the first request when the customer asks twice', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const first = await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = await requestCancellation(db, created.value.id, customerId, queue, 'Otro motivo');

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.cancellationRequestedAt).toEqual(first.value.cancellationRequestedAt);
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: created.value.id } });
      expect(stored.cancellationReason).toBe('Me enfermé');
      const entries = await db.auditLog.findMany({
        where: { entityId: created.value.id, action: 'reservation.cancellation_requested' },
      });
      expect(entries).toHaveLength(1);
    });

    it('accepts a request with no reason', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const requested = await requestCancellation(db, created.value.id, customerId, queue);

      expect(requested.ok).toBe(true);
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: created.value.id } });
      expect(stored.cancellationReason).toBeNull();
      expect(stored.cancellationRequestedAt).toBeInstanceOf(Date);
    });

    it('refuses a request against another customer reservation and writes nothing', async () => {
      const trip = await seedTrip(db);
      const owner = await seedCustomer(db);
      const stranger = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId: owner });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const requested = await requestCancellation(db, created.value.id, stranger, queue, 'No es mía');

      expect(requested.ok).toBe(false);
      if (!requested.ok) expect(requested.error.code).toBe('RESERVATION_NOT_OWNED');
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: created.value.id } });
      expect(stored.cancellationRequestedAt).toBeNull();
      expect(stored.cancellationReason).toBeNull();
    });

    it.each(['CANCELLED', 'EXPIRED'] as const)(
      'refuses a request against a reservation already in %s',
      async (status) => {
        const trip = await seedTrip(db);
        const customerId = await seedCustomer(db);
        const created = await createReservation(db, { tripId: trip.id, customerId });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        await db.reservation.update({ where: { id: created.value.id }, data: { status } });

        const requested = await requestCancellation(db, created.value.id, customerId, queue);

        expect(requested.ok).toBe(false);
        if (!requested.ok) expect(requested.error.code).toBe('INVALID_STATUS_TRANSITION');
      }
    );
  });

  describe('cancelReservation', () => {
    /** A HELD reservation on a fresh trip, plus everything the assertions read. */
    async function heldReservation(tripOverrides: Parameters<typeof seedTrip>[1] = {}) {
      const trip = await seedTrip(db, tripOverrides);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      if (!created.ok) throw new Error(`could not seed a reservation: ${created.error.code}`);
      return { trip, customerId, reservation: created.value };
    }

    async function seatsLeft(tripId: string): Promise<number> {
      const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId } });
      return availableSeats({
        totalCapacity: trip.totalCapacity,
        preSoldSeats: trip.preSoldSeats,
        ...(await countCommittedSeats(db, tripId)),
      });
    }

    it('releases the seat: the trip has one more seat available afterwards', async () => {
      const { trip, reservation } = await heldReservation({ totalCapacity: 3 });
      expect(await seatsLeft(trip.id)).toBe(2);

      const cancelled = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Solicitud del cliente',
      });

      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) return;
      expect(cancelled.value.status).toBe('CANCELLED');
      expect(await seatsLeft(trip.id)).toBe(3);
      // The seat comes back because the count stops seeing the row, not
      // because a stored counter moved: the trip row itself is untouched.
      const storedTrip = await db.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(storedTrip.totalCapacity).toBe(3);
      expect(storedTrip.preSoldSeats).toBe(0);
    });

    it('also cancels an ACTIVE reservation and releases its seat', async () => {
      const { trip, reservation } = await heldReservation({ totalCapacity: 1 });
      await db.reservation.update({
        where: { id: reservation.id },
        data: { status: 'ACTIVE', holdExpiresAt: null, paidCents: 100_000 },
      });
      expect(await seatsLeft(trip.id)).toBe(0);

      const cancelled = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Viaje reprogramado',
      });

      expect(cancelled.ok).toBe(true);
      expect(await seatsLeft(trip.id)).toBe(1);
    });

    it('keeps paid_cents and every recorded payment: applying or refunding that money is Phase 2B', async () => {
      const { reservation } = await heldReservation();
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'CARD',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
          providerIntentId: 'pi_kept',
          paidAt: new Date(),
        },
      });
      await db.reservation.update({
        where: { id: reservation.id },
        data: { status: 'ACTIVE', holdExpiresAt: null, paidCents: 150_000 },
      });

      const cancelled = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Solicitud del cliente',
      });

      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) return;
      expect(cancelled.value.paidCents).toBe(150_000);
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.paidCents).toBe(150_000);
      const payments = await db.payment.findMany({ where: { reservationId: reservation.id } });
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe('SUCCEEDED');
      expect(payments[0]?.amountCents).toBe(150_000);
    });

    it('records who cancelled and when, and keeps the customer request and its reason', async () => {
      const { customerId, reservation } = await heldReservation();
      await requestCancellation(db, reservation.id, customerId, queue, 'Me enfermé');

      const cancelled = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Solicitud del cliente',
      });

      expect(cancelled.ok).toBe(true);
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.cancelledById).toBe(staffId);
      expect(stored.cancelledAt).toBeInstanceOf(Date);
      expect(stored.cancellationRequestedAt).toBeInstanceOf(Date);
      expect(stored.cancellationReason).toBe('Me enfermé');
    });

    it('notifies the customer with RESERVATION_CANCELLED, naming the trip and the reason', async () => {
      const { customerId, reservation } = await heldReservation();

      await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Viaje reprogramado',
      });

      const deliveries = await db.notificationDelivery.findMany({
        where: { userId: customerId, eventType: 'RESERVATION_CANCELLED' },
      });
      expect(deliveries.map((delivery) => delivery.channel).sort()).toEqual(['EMAIL', 'INBOX']);
      expect(deliveries.every((delivery) => delivery.reservationId === reservation.id)).toBe(true);
      expect(deliveries.every((delivery) => delivery.renderedBody.includes('Viaje reprogramado'))).toBe(true);
      expect(deliveries.every((delivery) => delivery.renderedBody.includes('oaxaca-'))).toBe(true);
    });

    it('writes an audit entry with the actor and the reason', async () => {
      const { reservation } = await heldReservation();

      await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Viaje reprogramado',
      });

      const entries = await db.auditLog.findMany({
        where: { entityId: reservation.id, action: 'reservation.cancelled' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actorUserId).toBe(staffId);
      expect(entries[0]?.entityType).toBe('Reservation');
      expect(entries[0]?.before).toMatchObject({ status: 'HELD' });
      expect(entries[0]?.after).toMatchObject({ status: 'CANCELLED', reason: 'Viaje reprogramado' });
    });

    it('is idempotent on an already CANCELLED reservation: no second notice and no second audit entry', async () => {
      const { customerId, reservation } = await heldReservation();
      const first = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Primera',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Segunda',
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.status).toBe('CANCELLED');
      expect(second.value.cancelledAt).toEqual(first.value.cancelledAt);
      const notices = await db.notificationDelivery.count({
        where: { userId: customerId, eventType: 'RESERVATION_CANCELLED' },
      });
      expect(notices).toBe(2); // the first call's EMAIL + INBOX pair, nothing more
      const entries = await db.auditLog.count({
        where: { entityId: reservation.id, action: 'reservation.cancelled' },
      });
      expect(entries).toBe(1);
    });

    it('lets exactly one of two concurrent cancellations notify', async () => {
      const { customerId, reservation } = await heldReservation();

      const results = await Promise.all([
        cancelReservation(db, queue, { reservationId: reservation.id, actorId: staffId, reason: 'A' }),
        cancelReservation(db, queue, { reservationId: reservation.id, actorId: staffId, reason: 'B' }),
      ]);

      expect(results.every((result) => result.ok)).toBe(true);
      const notices = await db.notificationDelivery.count({
        where: { userId: customerId, eventType: 'RESERVATION_CANCELLED' },
      });
      expect(notices).toBe(2);
      const entries = await db.auditLog.count({
        where: { entityId: reservation.id, action: 'reservation.cancelled' },
      });
      expect(entries).toBe(1);
    });

    it('refuses an EXPIRED reservation: its seat is already free and there is nothing to decide', async () => {
      const { reservation } = await heldReservation();
      await db.reservation.update({ where: { id: reservation.id }, data: { status: 'EXPIRED' } });

      const cancelled = await cancelReservation(db, queue, {
        reservationId: reservation.id,
        actorId: staffId,
        reason: 'Tarde',
      });

      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.error.code).toBe('INVALID_STATUS_TRANSITION');
      const stored = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.status).toBe('EXPIRED');
      expect(stored.cancelledById).toBeNull();
    });

    it('answers NOT_FOUND for an id that is no reservation', async () => {
      const cancelled = await cancelReservation(db, queue, {
        reservationId: '00000000-0000-4000-8000-000000000000',
        actorId: staffId,
        reason: 'Nada',
      });

      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.error.code).toBe('NOT_FOUND');
    });

    it('asks to cancel the pending payment intents, inside the cancellation, exactly once', async () => {
      const { reservation } = await heldReservation();
      const calls: string[] = [];

      await cancelReservation(
        db,
        queue,
        { reservationId: reservation.id, actorId: staffId, reason: 'Viaje reprogramado' },
        async (_tx, reservationId) => {
          calls.push(reservationId);
        }
      );
      await cancelReservation(
        db,
        queue,
        { reservationId: reservation.id, actorId: staffId, reason: 'Otra vez' },
        async (_tx, reservationId) => {
          calls.push(reservationId);
        }
      );

      expect(calls).toEqual([reservation.id]);
    });
  });

  describe('listReservationsForStaff', () => {
    it('puts unresolved cancellation requests first, oldest request first, then the rest newest first', async () => {
      const trip = await seedTrip(db);
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const customerId = await seedCustomer(db);
        const created = await createReservation(db, { tripId: trip.id, customerId });
        if (!created.ok) throw new Error(created.error.code);
        ids.push(created.value.id);
        await settle(5);
      }
      const [oldest, second, third, newest] = ids as [string, string, string, string];
      // Two requests, the later reservation asking first.
      const thirdRow = await db.reservation.findUniqueOrThrow({ where: { id: third } });
      await requestCancellation(db, third, thirdRow.customerId, queue, 'Primero');
      await settle(5);
      const secondRow = await db.reservation.findUniqueOrThrow({ where: { id: second } });
      await requestCancellation(db, second, secondRow.customerId, queue, 'Después');

      const listed = await listReservationsForStaff(db, {});

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.map((row) => row.id)).toEqual([third, second, newest, oldest]);
      expect(listed.value.map((row) => row.cancellationPending)).toEqual([true, true, false, false]);
    });

    it('does not count a request on a reservation that is no longer live as pending', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      if (!created.ok) throw new Error(created.error.code);
      await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');
      await db.reservation.update({ where: { id: created.value.id }, data: { status: 'EXPIRED' } });

      const listed = await listReservationsForStaff(db, { cancellationPending: true });

      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.value).toEqual([]);
    });

    it('filters by trip and by status', async () => {
      const tripA = await seedTrip(db);
      const tripB = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const inA = await createReservation(db, { tripId: tripA.id, customerId });
      const inB = await createReservation(db, { tripId: tripB.id, customerId });
      if (!inA.ok || !inB.ok) throw new Error('seed failed');
      await db.reservation.update({ where: { id: inB.value.id }, data: { status: 'CANCELLED' } });

      const byTrip = await listReservationsForStaff(db, { tripId: tripA.id });
      const byStatus = await listReservationsForStaff(db, { status: 'CANCELLED' });
      const both = await listReservationsForStaff(db, { tripId: tripA.id, status: 'CANCELLED' });

      expect(byTrip.ok && byTrip.value.map((row) => row.id)).toEqual([inA.value.id]);
      expect(byStatus.ok && byStatus.value.map((row) => row.id)).toEqual([inB.value.id]);
      expect(both.ok && both.value).toEqual([]);
    });

    it('names the trip and the customer on every row', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      if (!created.ok) throw new Error(created.error.code);

      const listed = await listReservationsForStaff(db, {});

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value[0]).toMatchObject({
        code: created.value.code,
        tripId: trip.id,
        tripName: trip.slug,
        customerId,
        customerName: expect.stringMatching(/^Cliente /),
        status: 'HELD',
        balanceCents: 500_000,
        cancellationRequestedAt: null,
        cancellationPending: false,
      });
    });
  });

  describe('getReservationForStaff', () => {
    it('returns any reservation with its customer contact and the request reason', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      if (!created.ok) throw new Error(created.error.code);
      await requestCancellation(db, created.value.id, customerId, queue, 'Me enfermé');

      const detail = await getReservationForStaff(db, created.value.id);

      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.value).toMatchObject({
        id: created.value.id,
        tripName: trip.slug,
        customerName: expect.stringMatching(/^Cliente /),
        customerEmail: expect.stringMatching(/@agency\.test$/),
        customerPhone: '5512345678',
        cancellationReason: 'Me enfermé',
        cancellationPending: true,
        cancelledAt: null,
        cancelledByName: null,
      });
    });

    it('names the staff member who cancelled it', async () => {
      const trip = await seedTrip(db);
      const customerId = await seedCustomer(db);
      const created = await createReservation(db, { tripId: trip.id, customerId });
      if (!created.ok) throw new Error(created.error.code);
      await cancelReservation(db, queue, { reservationId: created.value.id, actorId: staffId, reason: 'x' });

      const detail = await getReservationForStaff(db, created.value.id);

      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.value.cancelledByName).toBe('Staff');
      expect(detail.value.cancelledAt).toBeInstanceOf(Date);
      expect(detail.value.cancellationPending).toBe(false);
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const detail = await getReservationForStaff(db, '00000000-0000-4000-8000-000000000000');

      expect(detail.ok).toBe(false);
      if (!detail.ok) expect(detail.error.code).toBe('NOT_FOUND');
    });
  });
});
