import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { Db, DbTransactionClient, Reservation, ReservationStatus } from '@rm/db';
import { createCancelPendingPaymentIntents, recordPayment } from '@rm/domain-payments';
import { FakePaymentProvider, PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID } from '@rm/payments-stripe';
import { expireHolds } from './expire-holds';

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;

/** A promise plus the handle that settles it, used to pin down an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/** Gives the other transaction time to reach the row lock before this one commits. */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

/** Writes a `PENDING` Payment row directly -- test setup only, bypassing `recordPayment`'s own rules. */
async function seedPendingPayment(client: Db, reservationId: string, providerIntentId: string): Promise<void> {
  await client.payment.create({
    data: {
      reservationId,
      amountCents: 100_000,
      method: 'CARD',
      status: 'PENDING',
      provider: 'STRIPE',
      providerIntentId,
    },
  });
}

async function seedReservation(
  client: Db,
  overrides: {
    status?: ReservationStatus;
    minimumDepositCents?: number;
    holdExpiresAt?: Date | null;
    customerId?: string;
  } = {}
): Promise<Reservation> {
  const index = next();
  const customerId = overrides.customerId ?? (await seedCustomer(client));
  const trip = await client.trip.create({
    data: {
      slug: `oaxaca-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      createdById: staffId,
    },
  });
  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-EXP${index}`,
      tripId: trip.id,
      customerId,
      status,
      holdExpiresAt:
        overrides.holdExpiresAt === undefined
          ? status === 'HELD'
            ? new Date(Date.now() + 72 * HOUR_MS)
            : null
          : overrides.holdExpiresAt,
      totalPriceCents: 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

/**
 * Wraps a real client so one Prisma call inside `expireHolds`'s own
 * transaction waits on `pause`. Same shape as `clientPausingAt` in
 * `payment-service.spec.ts` and `reservation-service.spec.ts` -- the
 * concurrency test needs `expireHolds` parked between reading its
 * candidates and writing one of them, with a second, independent
 * transaction running into the window it leaves open.
 */
interface PausePoint {
  model: 'reservation';
  operation: string;
  when: 'before' | 'after';
}

function clientPausingAt(client: Db, point: PausePoint, pause: () => Promise<void>): Db {
  const forward = (target: object, property: string | symbol) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };

  const pausingTransactionClient = (tx: DbTransactionClient): DbTransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        if (property !== point.model) return forward(target, property);
        const model = Reflect.get(target, property) as object;
        return new Proxy(model, {
          get(delegate, operation) {
            if (operation !== point.operation) return forward(delegate, operation);
            const call = forward(delegate, operation) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (point.when === 'before') await pause();
              const result = await call(...args);
              if (point.when === 'after') await pause();
              return result;
            };
          },
        });
      },
    }) as DbTransactionClient;

  return new Proxy(client, {
    get(target, property) {
      if (property !== '$transaction') return forward(target, property);
      return (run: (tx: DbTransactionClient) => Promise<unknown>) =>
        target.$transaction((tx) => run(pausingTransactionClient(tx)));
    },
  }) as Db;
}

describe('expireHolds', () => {
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

  it('expires a HELD reservation whose hold has passed, releasing the seat', async () => {
    const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
    const boss = await withTestQueue();

    await expireHolds(db, boss);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('EXPIRED');
    expect(after.holdExpiresAt).toBeNull();
  });

  it('does not touch a HELD reservation whose hold is still running', async () => {
    const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() + HOUR_MS) });
    const boss = await withTestQueue();

    await expireHolds(db, boss);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('HELD');
  });

  it('never touches an ACTIVE reservation, even one carrying an old hold_expires_at', async () => {
    const reservation = await seedReservation(db, {
      status: 'ACTIVE',
      holdExpiresAt: new Date(Date.now() - HOUR_MS),
    });
    // ACTIVE with a non-null hold_expires_at cannot be written through the
    // domain (confirmPayment/recordPayment always null it in the same
    // statement), but nothing stops seeding it directly for this test --
    // and `expireHolds` must leave it alone regardless of how it got there.
    await db.reservation.update({ where: { id: reservation.id }, data: { holdExpiresAt: new Date(Date.now() - HOUR_MS) } });
    const boss = await withTestQueue();

    await expireHolds(db, boss);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('running it twice in a row changes nothing the second time', async () => {
    const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
    const boss = await withTestQueue();

    await expireHolds(db, boss);
    await expireHolds(db, boss);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('EXPIRED');
    // Only the first run's expiry produced a notice -- the second found
    // nothing left to expire and sent nothing again.
    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(2); // one EMAIL + one INBOX, not four
  });

  it('writes a HOLD_EXPIRED notice to the customer when it expires a hold', async () => {
    const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
    const boss = await withTestQueue();

    await expireHolds(db, boss);

    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((row) => row.eventType === 'HOLD_EXPIRED')).toBe(true);
    expect(deliveries.every((row) => row.userId === reservation.customerId)).toBe(true);
  });

  it('does not resurrect or clobber a reservation that a concurrent payment activated while expireHolds was mid-pass', async () => {
    const reservation = await seedReservation(db, {
      minimumDepositCents: 100_000,
      holdExpiresAt: new Date(Date.now() - HOUR_MS), // a real expiry candidate
    });
    const boss = await withTestQueue();

    const expireHasReadCandidates = deferred();
    const paymentHasActivated = deferred();
    const pausing = clientPausingAt(db, { model: 'reservation', operation: 'updateMany', when: 'before' }, async () => {
      expireHasReadCandidates.resolve();
      await paymentHasActivated.promise;
    });

    // `expireHolds` has already read this reservation as an expiry
    // candidate and is paused right before writing it. A fully independent
    // transaction -- a cash payment covering the deposit -- activates the
    // reservation and commits inside that window.
    const expiring = expireHolds(pausing, boss);

    const paying = (async () => {
      await expireHasReadCandidates.promise;
      return db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 100_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );
    })();

    await settle(200);
    paymentHasActivated.resolve();

    const [, paid] = await Promise.all([expiring, paying]);

    expect(paid.ok).toBe(true);
    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.holdExpiresAt).toBeNull();
    // `expireHolds` lost the race for this row -- it must not have sent a
    // HOLD_EXPIRED notice for a reservation that is, in fact, active.
    const deliveries = await db.notificationDelivery.findMany({ where: { reservationId: reservation.id } });
    expect(deliveries).toHaveLength(0);
  });

  describe('cancelling pending Payment Intents (Task 9, closing the Task 8 hook)', () => {
    it("cancels a reservation's pending Payment Intent at the provider when its hold expires", async () => {
      const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
      const boss = await withTestQueue();
      const provider = new FakePaymentProvider();
      const created = await provider.createIntent({
        reservationId: 'intent-seed-cancel',
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await seedPendingPayment(db, reservation.id, created.value.providerIntentId);

      await expireHolds(db, boss, createCancelPendingPaymentIntents(provider));

      expect(provider.inspect(created.value.providerIntentId)).toEqual({ status: 'canceled' });
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('EXPIRED');
    });

    it('running it twice does not cancel the same Payment Intent twice', async () => {
      const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
      const boss = await withTestQueue();
      const provider = new FakePaymentProvider();
      const created = await provider.createIntent({
        reservationId: 'intent-seed-double-cancel',
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await seedPendingPayment(db, reservation.id, created.value.providerIntentId);
      const cancelSpy = vi.spyOn(provider, 'cancelIntent');
      const cancelPendingPaymentIntents = createCancelPendingPaymentIntents(provider);

      // Second run finds no HELD candidate left (the first already flipped
      // it to EXPIRED), so the per-reservation loop body -- and therefore
      // this hook -- never runs a second time for the same row.
      await expireHolds(db, boss, cancelPendingPaymentIntents);
      await expireHolds(db, boss, cancelPendingPaymentIntents);

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(provider.inspect(created.value.providerIntentId)).toEqual({ status: 'canceled' });
    });

    it('still releases the seat and logs the failure when the provider rejects the cancellation', async () => {
      const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() - HOUR_MS) });
      const boss = await withTestQueue();
      const provider = new FakePaymentProvider();
      const created = await provider.createIntent({
        reservationId: PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID,
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await seedPendingPayment(db, reservation.id, created.value.providerIntentId);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expireHolds(db, boss, createCancelPendingPaymentIntents(provider));

      // The seat is released regardless of the provider outage -- the
      // opposite would let a third party's failure freeze it indefinitely.
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('EXPIRED');
      expect(after.holdExpiresAt).toBeNull();
      // Read before mockRestore(), which clears mock.calls as part of
      // restoring the original implementation (see create-email.spec.ts's
      // captureConsoleLog for the same caution).
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
