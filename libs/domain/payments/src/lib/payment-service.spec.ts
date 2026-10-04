import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { closeTestDb, prepareTestDb, resetDatabase, TEST_SCHEMA, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient, Reservation, ReservationStatus } from '@rm/db';
import type { Result } from '@rm/shared-utils';
import {
  confirmPayment,
  confirmPaymentWithin,
  listPaymentsForCustomer,
  recordPayment,
  suggestedMonthlyForReservation,
} from './payment-service';

const db = withTestDb();

const HOUR_MS = 60 * 60 * 1000;
const TIME_ZONE = 'America/Mexico_City';

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
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Seeds a trip, a customer and a reservation directly through Prisma rather
 * than through `createReservation`.
 *
 * `@rm/domain-payments` must stay a leaf that `@rm/domain-reservations` does
 * not depend on and does not depend back upon; importing the reservation
 * service here -- even only in a test -- would put that edge in the Nx graph.
 */
async function seedReservation(
  client: Db,
  overrides: {
    status?: ReservationStatus;
    totalPriceCents?: number;
    minimumDepositCents?: number;
    paidCents?: number;
    holdExpiresAt?: Date | null;
    paymentDeadline?: Date;
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
      paymentDeadline: overrides.paymentDeadline ?? new Date('2027-11-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.totalPriceCents ?? 500_000,
      createdById: staffId,
    },
  });

  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-TEST${index}`,
      tripId: trip.id,
      customerId,
      status,
      // A HELD row without an expiry is refused by the CHECK constraint
      // `reservations_held_requires_hold_expiry`.
      holdExpiresAt:
        overrides.holdExpiresAt === undefined
          ? status === 'HELD'
            ? new Date(Date.now() + 72 * HOUR_MS)
            : null
          : overrides.holdExpiresAt,
      totalPriceCents: overrides.totalPriceCents ?? 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paidCents: overrides.paidCents ?? 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

async function setOrganizationTimeZone(client: Db, timeZone: string): Promise<void> {
  await client.systemSetting.upsert({
    where: { key: 'organization.timezone' },
    create: { key: 'organization.timezone', value: timeZone },
    update: { value: timeZone },
  });
}

async function succeededTotal(client: Db, reservationId: string): Promise<number> {
  const sum = await client.payment.aggregate({
    where: { reservationId, status: 'SUCCEEDED' },
    _sum: { amountCents: true },
  });
  return sum._sum.amountCents ?? 0;
}

/** Where a proxied client parks the transaction, and whether before or after the call. */
interface PausePoint {
  model: 'payment' | 'reservation';
  operation: string;
  when: 'before' | 'after';
}

/**
 * Wraps a real client so that one Prisma call inside the service's own
 * transaction waits on `pause` -- before it runs, or after it has run and
 * while its row locks are still held.
 *
 * The concurrency tests need one transaction parked at a chosen point while
 * a second one runs into the window it leaves open. The services deliberately
 * have no hook for that (a test seam in production code would be the thing
 * under test), so the seam is the injected client they already take: the
 * proxy is transparent for everything except the one call whose timing the
 * test is about. Same shape as `clientPausingBeforeInsert` in
 * `reservation-service.spec.ts`.
 */
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

/**
 * Calls `recordPayment` the way a real caller must: a failed `Result` rolls
 * the transaction back instead of committing on top of it.
 *
 * This is not test ceremony. When the unique index on `provider_intent_id`
 * is what rejected the insert, PostgreSQL has already aborted the
 * transaction, so there is nothing left to commit -- `recordPayment`'s job
 * is only to report that as a `Result` instead of a thrown `P2002`, and the
 * caller's job is to roll back. `handleStripeEvent` has the same shape.
 */
class Rollback<T> extends Error {
  constructor(readonly result: Result<T>) {
    super('rollback');
  }
}

async function recordPaymentRollingBackOnFailure(
  input: Parameters<typeof recordPayment>[1]
): Promise<Result<unknown>> {
  try {
    return await db.$transaction(async (tx: DbTransactionClient) => {
      const result = await recordPayment(tx, input);
      if (!result.ok) throw new Rollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    throw error;
  }
}

describe('payment service', () => {
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
    await setOrganizationTimeZone(db, TIME_ZONE);
  });

  afterAll(() => closeTestDb());

  describe('recordPayment', () => {
    it('moves paid_cents in the same transaction as the payment that causes it', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });

      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'CARD',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
        })
      );

      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      expect(recorded.value.amountCents).toBe(150_000);
      expect(recorded.value.status).toBe('SUCCEEDED');

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      // The denormalised column and the payment rows must agree: the nightly
      // reconciliation job compares exactly these two numbers.
      expect(after.paidCents).toBe(await succeededTotal(db, reservation.id));
      expect(after.totalPriceCents - after.paidCents).toBe(350_000);
    });

    it('leaves the balance untouched for a pending payment', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });

      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'OXXO',
          status: 'PENDING',
          provider: 'STRIPE',
          providerIntentId: 'pi_pending_1',
        })
      );

      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      expect(recorded.value.status).toBe('PENDING');
      expect(recorded.value.paidAt).toBeNull();

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(after.status).toBe('HELD');
      expect(await succeededTotal(db, reservation.id)).toBe(0);
    });

    it('rejects an amount above the outstanding balance', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 500_000,
        paidCents: 400_000,
      });

      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 100_001,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );

      expect(recorded.ok).toBe(false);
      if (recorded.ok) return;
      expect(recorded.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
      expect(recorded.error.details).toEqual({ amountCents: 100_001, balanceCents: 100_000 });

      expect(await db.payment.count()).toBe(0);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(400_000);
    });

    it('accepts a payment that settles the balance exactly', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 500_000,
        paidCents: 400_000,
      });

      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 100_000,
          method: 'SPEI',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );

      expect(recorded.ok).toBe(true);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(500_000);
    });

    it('rejects an amount that is not a positive whole number of cents', async () => {
      const reservation = await seedReservation(db);

      for (const amountCents of [0, -1, 1.5]) {
        const recorded = await db.$transaction((tx) =>
          recordPayment(tx, {
            reservationId: reservation.id,
            amountCents,
            method: 'CASH',
            status: 'SUCCEEDED',
            provider: 'MANUAL',
          })
        );
        expect(recorded.ok).toBe(false);
        if (recorded.ok) return;
        expect(recorded.error.code).toBe('VALIDATION_FAILED');
        expect(recorded.error.details).toEqual({ field: 'amountCents' });
      }

      expect(await db.payment.count()).toBe(0);
    });

    it('rejects a payment for a reservation that does not exist', async () => {
      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: '11111111-1111-1111-1111-111111111111',
          amountCents: 1_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );

      expect(recorded.ok).toBe(false);
      if (recorded.ok) return;
      expect(recorded.error.code).toBe('NOT_FOUND');
    });

    it('activates the reservation and clears the hold once the minimum deposit is covered', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 500_000,
        minimumDepositCents: 100_000,
      });
      expect(reservation.holdExpiresAt).not.toBeNull();

      await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 100_000,
          method: 'CARD',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
        })
      );

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('ACTIVE');
      // Not cosmetic: a CHECK constraint ties HELD to a non-null expiry, and
      // an ACTIVE row that kept one would read as a hold that never ends.
      expect(after.holdExpiresAt).toBeNull();
    });

    it('reaches the minimum deposit across several payments', async () => {
      const reservation = await seedReservation(db, { minimumDepositCents: 100_000 });

      for (const amountCents of [40_000, 60_000]) {
        await db.$transaction((tx) =>
          recordPayment(tx, {
            reservationId: reservation.id,
            amountCents,
            method: 'CASH',
            status: 'SUCCEEDED',
            provider: 'MANUAL',
          })
        );
      }

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(100_000);
      expect(after.status).toBe('ACTIVE');
      expect(after.holdExpiresAt).toBeNull();
    });

    it('leaves the hold running when the payment falls short of the minimum deposit', async () => {
      const reservation = await seedReservation(db, { minimumDepositCents: 100_000 });

      await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 99_999,
          method: 'CARD',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
        })
      );

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('HELD');
      expect(after.holdExpiresAt).toEqual(reservation.holdExpiresAt);
      expect(after.paidCents).toBe(99_999);
    });

    it('stamps paid_at for a confirmed payment and leaves it null for a pending one', async () => {
      const reservation = await seedReservation(db);
      const paidAt = new Date('2026-03-15T18:00:00.000Z');

      const backdated = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 10_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
          paidAt,
        })
      );
      expect(backdated.ok).toBe(true);
      if (!backdated.ok) return;
      // Reports read `paidAt`, so a March payment captured in September has to
      // keep saying March.
      expect(backdated.value.paidAt).toEqual(paidAt);
      expect(backdated.value.recordedAt.getTime()).toBeGreaterThan(paidAt.getTime());

      const stamped = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 10_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );
      expect(stamped.ok).toBe(true);
      if (!stamped.ok) return;
      expect(stamped.value.paidAt).not.toBeNull();
    });

    it('records an audit entry inside the same transaction', async () => {
      const reservation = await seedReservation(db);

      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 10_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;

      const [entry] = await db.auditLog.findMany({ where: { entityType: 'Payment' } });
      expect(entry.action).toBe('payment.recorded');
      expect(entry.entityId).toBe(recorded.value.id);
    });

    it('rolls back the payment and the balance together when the caller aborts', async () => {
      const reservation = await seedReservation(db);

      await expect(
        db.$transaction(async (tx) => {
          const recorded = await recordPayment(tx, {
            reservationId: reservation.id,
            amountCents: 150_000,
            method: 'CARD',
            status: 'SUCCEEDED',
            provider: 'STRIPE',
          });
          expect(recorded.ok).toBe(true);
          throw new Error('the caller failed after the payment');
        })
      ).rejects.toThrow('the caller failed after the payment');

      // Neither half survives: the balance is only ever moved by the same
      // transaction that writes the payment row.
      expect(await db.payment.count()).toBe(0);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(await db.auditLog.count({ where: { entityType: 'Payment' } })).toBe(0);
    });

    it('refuses a second payment for the same provider intent', async () => {
      const reservation = await seedReservation(db);
      const input = {
        reservationId: reservation.id,
        amountCents: 10_000,
        method: 'OXXO' as const,
        status: 'PENDING' as const,
        provider: 'STRIPE' as const,
        providerIntentId: 'pi_duplicate',
      };

      const first = await db.$transaction((tx) => recordPayment(tx, input));
      expect(first.ok).toBe(true);

      const second = await db.$transaction((tx) => recordPayment(tx, input));
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('CONFLICT');
      expect(second.error.details).toEqual({ field: 'providerIntentId' });

      expect(await db.payment.count()).toBe(1);
    });

    it('calls a redelivered intent a duplicate even once it has consumed the balance', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 100_000 });
      const input = {
        reservationId: reservation.id,
        amountCents: 100_000,
        method: 'CARD' as const,
        status: 'SUCCEEDED' as const,
        provider: 'STRIPE' as const,
        providerIntentId: 'pi_settles_everything',
      };

      const first = await db.$transaction((tx) => recordPayment(tx, input));
      expect(first.ok).toBe(true);

      const second = await db.$transaction((tx) => recordPayment(tx, input));

      // The balance is now zero, so checking it first would answer
      // PAYMENT_EXCEEDS_BALANCE -- "this payment is wrong" instead of "this
      // payment is already here", and the webhook would retry forever.
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('CONFLICT');

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(100_000);
    });

    it('still allows many manual payments, which carry no provider intent', async () => {
      const reservation = await seedReservation(db);

      for (let i = 0; i < 3; i++) {
        const recorded = await db.$transaction((tx) =>
          recordPayment(tx, {
            reservationId: reservation.id,
            amountCents: 1_000,
            method: 'CASH',
            status: 'SUCCEEDED',
            provider: 'MANUAL',
          })
        );
        expect(recorded.ok).toBe(true);
      }

      expect(await db.payment.count()).toBe(3);
    });

    it('stops two concurrent payments from together exceeding the balance', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });

      const firstHasLocked = deferred();
      const firstMayInsert = deferred();
      const pausing = clientPausingAt(
        db,
        { model: 'payment', operation: 'create', when: 'before' },
        async () => {
          firstHasLocked.resolve();
          await firstMayInsert.promise;
        }
      );

      // Both attempts are in flight before either is awaited. The first one
      // stops holding the reservation's row lock, with its balance already
      // read; the second then runs the whole read-decide-write sequence into
      // that open window. Without the lock both read a 500,000 balance and
      // both record 300,000.
      const first = pausing.$transaction((tx: DbTransactionClient) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 300_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );
      const second = (async () => {
        await firstHasLocked.promise;
        return db.$transaction((tx) =>
          recordPayment(tx, {
            reservationId: reservation.id,
            amountCents: 300_000,
            method: 'CASH',
            status: 'SUCCEEDED',
            provider: 'MANUAL',
          })
        );
      })();

      // Long enough for the second attempt to reach the row lock. It is not
      // load-bearing: too short and the second attempt simply queues behind a
      // lock that has already been released, reads the committed balance and
      // is still rejected.
      await settle(200);
      firstMayInsert.resolve();

      const results = await Promise.all([first, second]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const rejected = results.find((result) => !result.ok);
      if (rejected && !rejected.ok) expect(rejected.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(300_000);
      expect(after.paidCents).toBe(await succeededTotal(db, reservation.id));
    });

    it('returns a CONFLICT Result, never a thrown P2002, when the duplicate pre-check loses a race', async () => {
      // Inherited Task 5 finding. The `findUnique` guarding
      // `provider_intent_id` cannot see a row another transaction has not
      // committed yet, so two deliveries in flight at once both pass it and
      // the second one lands on `payments_provider_intent_id_key`. Before
      // this, that surfaced as a raw `P2002` exception: inside a webhook
      // handler that is a 500, and Stripe retries a 500 forever.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });

      const firstHasInserted = deferred();
      const firstMayCommit = deferred();
      const pausing = clientPausingAt(
        db,
        { model: 'payment', operation: 'create', when: 'after' },
        async () => {
          firstHasInserted.resolve();
          await firstMayCommit.promise;
        }
      );

      const input = {
        reservationId: reservation.id,
        amountCents: 100_000,
        method: 'CARD' as const,
        status: 'SUCCEEDED' as const,
        provider: 'STRIPE' as const,
        providerIntentId: 'pi_duplicate_race',
      };

      const first = pausing.$transaction((tx: DbTransactionClient) => recordPayment(tx, input));
      const second = (async () => {
        await firstHasInserted.promise;
        return recordPaymentRollingBackOnFailure(input);
      })();

      // Long enough for the second attempt to clear its own pre-check (which
      // sees nothing: the first row is still uncommitted) and queue behind
      // the reservation's row lock.
      await settle(200);
      firstMayCommit.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { field: 'providerIntentId' } } });
      expect(await db.payment.count({ where: { providerIntentId: 'pi_duplicate_race' } })).toBe(1);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(100_000);
    });
  });

  describe('confirmPayment', () => {
    async function seedPendingPayment(
      reservationId: string,
      providerIntentId: string,
      amountCents = 150_000
    ): Promise<string> {
      const recorded = await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId,
          amountCents,
          method: 'OXXO',
          status: 'PENDING',
          provider: 'STRIPE',
          providerIntentId,
        })
      );
      if (!recorded.ok) throw new Error(`seeding failed: ${recorded.error.code}`);
      return recorded.value.id;
    }

    it('confirms the pending payment, stamps paid_at and moves the balance', async () => {
      const reservation = await seedReservation(db, { minimumDepositCents: 100_000 });
      const paymentId = await seedPendingPayment(reservation.id, 'pi_confirm');
      const paidAt = new Date('2026-10-04T12:00:00.000Z');

      const confirmed = await confirmPayment(db, { providerIntentId: 'pi_confirm', paidAt });

      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.id).toBe(paymentId);
      expect(confirmed.value.status).toBe('SUCCEEDED');
      expect(confirmed.value.paidAt).toEqual(paidAt);

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(after.status).toBe('ACTIVE');
      expect(after.holdExpiresAt).toBeNull();
      expect(await db.payment.count({ where: { reservationId: reservation.id } })).toBe(1);
    });

    it('is a no-op the second time the same intent is confirmed', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(reservation.id, 'pi_twice');
      const paidAt = new Date('2026-10-04T12:00:00.000Z');

      const first = await confirmPayment(db, { providerIntentId: 'pi_twice', paidAt });
      const second = await confirmPayment(db, {
        providerIntentId: 'pi_twice',
        paidAt: new Date('2026-10-05T12:00:00.000Z'),
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // The first confirmation is the one that stands, its timestamp included.
      expect(second.value.paidAt).toEqual(paidAt);

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(await db.payment.count()).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'payment.confirmed' } })).toBe(1);
    });

    it('applies two concurrent confirmations of the same intent exactly once', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });
      await seedPendingPayment(reservation.id, 'pi_race', 150_000);
      const paidAt = new Date('2026-10-04T12:00:00.000Z');

      const firstHasFlipped = deferred();
      const firstMayCommit = deferred();
      const pausing = clientPausingAt(
        db,
        { model: 'payment', operation: 'updateMany', when: 'after' },
        async () => {
          firstHasFlipped.resolve();
          await firstMayCommit.promise;
        }
      );

      // The first confirmation stops right after flipping the row to
      // SUCCEEDED, still uncommitted and still holding that row's lock. The
      // second then starts, reads the payment as PENDING -- because the first
      // has not committed -- and walks the whole confirm path into the open
      // window. Only the conditional update can tell them apart; a plain read
      // followed by an unconditional write applies the money twice.
      const first = confirmPayment(pausing, { providerIntentId: 'pi_race', paidAt });
      const second = (async () => {
        await firstHasFlipped.promise;
        return confirmPayment(db, { providerIntentId: 'pi_race', paidAt });
      })();

      await settle(200);
      firstMayCommit.resolve();

      const results = await Promise.all([first, second]);

      expect(results.every((result) => result.ok)).toBe(true);
      expect(await db.payment.count()).toBe(1);
      const payment = await db.payment.findFirstOrThrow();
      expect(payment.status).toBe('SUCCEEDED');

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(after.paidCents).toBe(await succeededTotal(db, reservation.id));
      expect(await db.auditLog.count({ where: { action: 'payment.confirmed' } })).toBe(1);
    });

    it('fails when no payment carries that provider intent', async () => {
      const confirmed = await confirmPayment(db, {
        providerIntentId: 'pi_unknown',
        paidAt: new Date(),
      });

      expect(confirmed.ok).toBe(false);
      if (confirmed.ok) return;
      expect(confirmed.error.code).toBe('NOT_FOUND');
    });

    it('refuses to confirm a payment that already failed', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(reservation.id, 'pi_failed');
      await db.payment.updateMany({
        where: { providerIntentId: 'pi_failed' },
        data: { status: 'FAILED' },
      });

      const confirmed = await confirmPayment(db, {
        providerIntentId: 'pi_failed',
        paidAt: new Date(),
      });

      expect(confirmed.ok).toBe(false);
      if (confirmed.ok) return;
      expect(confirmed.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(confirmed.error.details).toEqual({ status: 'FAILED' });

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
    });

    it('records the money of an expired reservation without reviving it', async () => {
      // Spec section 5.3: a voucher confirmed after the hold expired. The money
      // exists and must be visible; reactivating the seat is a human decision.
      const reservation = await seedReservation(db, {
        status: 'EXPIRED',
        holdExpiresAt: new Date(Date.now() - HOUR_MS),
        minimumDepositCents: 100_000,
      });
      await seedPendingPayment(reservation.id, 'pi_late');

      const confirmed = await confirmPayment(db, {
        providerIntentId: 'pi_late',
        paidAt: new Date(),
      });

      expect(confirmed.ok).toBe(true);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('EXPIRED');
      expect(after.paidCents).toBe(150_000);
      expect(after.paidCents).toBe(await succeededTotal(db, reservation.id));
    });

    it('does not resurrect a reservation that a concurrent hold-expiry already won the race and committed EXPIRED', async () => {
      // Carried from Task 5's review (see Task 8's brief): `applyConfirmedPayment`
      // activates a reservation with an `update` keyed only on `id`, unconditional
      // on status. `expireHolds` (apps/worker, Task 8) is the first other writer
      // that ever contends for this exact row, so this proves `confirmPayment`
      // cannot revive a reservation `expireHolds` has already expired, even when
      // the two are racing for the same row rather than running one after the
      // other. The complementary ordering -- `expireHolds` arriving after a
      // payment has *already* activated the reservation -- is `expireHolds`'s own
      // responsibility and is proved in `apps/worker`'s `expire-holds.spec.ts`,
      // where that job's write (not this one) is what must stay conditional.
      const reservation = await seedReservation(db, {
        minimumDepositCents: 100_000,
        holdExpiresAt: new Date(Date.now() - HOUR_MS), // already past -- a real expireHolds candidate
      });
      await seedPendingPayment(reservation.id, 'pi_expiring_race', 150_000);

      const expiryHasLocked = deferred();
      const expiryMayCommit = deferred();
      const pausingExpiry = clientPausingAt(
        db,
        { model: 'reservation', operation: 'updateMany', when: 'after' },
        async () => {
          expiryHasLocked.resolve();
          await expiryMayCommit.promise;
        }
      );

      // Stands in for one row of `expireHolds`'s own work: a single
      // conditional `UPDATE ... WHERE status = 'HELD'`, exactly the shape
      // Task 8 gives that job. Takes the row lock first and holds it,
      // uncommitted, while `confirmPayment` starts and blocks behind it --
      // a real wait enforced by PostgreSQL, not a hand-wavy precondition.
      const expiring = pausingExpiry.$transaction((tx) =>
        tx.reservation.updateMany({
          where: { id: reservation.id, status: 'HELD' },
          data: { status: 'EXPIRED', holdExpiresAt: null },
        })
      );

      const confirming = (async () => {
        await expiryHasLocked.promise;
        return confirmPayment(db, { providerIntentId: 'pi_expiring_race', paidAt: new Date() });
      })();

      // Long enough for `confirmPayment` to reach the row lock and queue
      // behind it before the expiry transaction commits.
      await settle(200);
      expiryMayCommit.resolve();

      const [expired, confirmed] = await Promise.all([expiring, confirming]);

      expect(expired.count).toBe(1);
      expect(confirmed.ok).toBe(true);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      // The money is visible either way (paid_cents still moves); what must
      // not happen is the confirmation silently overwriting the expiry that
      // already committed.
      expect(after.paidCents).toBe(150_000);
      expect(after.status).toBe('EXPIRED');
      expect(after.holdExpiresAt).toBeNull();
    });
  });

  describe('confirmPayment for an intent with no local row', () => {
    it('records the payment Stripe says it took, instead of answering NOT_FOUND', async () => {
      // Inherited Task 5 finding. Stripe can deliver
      // `payment_intent.succeeded` before the transaction that was going to
      // write our own PENDING row ever committed -- or for an intent created
      // outside this app entirely. Money Stripe has taken and we have no row
      // for is the worst outcome available here, so `confirmPayment` is given
      // enough to write the row rather than dropping the event.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000, minimumDepositCents: 100_000 });
      const paidAt = new Date('2026-10-04T12:00:00.000Z');

      const confirmed = await confirmPayment(db, {
        providerIntentId: 'pi_never_seen',
        paidAt,
        recordIfMissing: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'CARD',
          provider: 'STRIPE',
        },
      });

      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value).toMatchObject({ amountCents: 150_000, status: 'SUCCEEDED', paidAt });

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(after.paidCents).toBe(await succeededTotal(db, reservation.id));
      expect(after.status).toBe('ACTIVE');
    });

    it('still answers NOT_FOUND when the caller has nothing to record it against', async () => {
      // Without `recordIfMissing` the signature carries no amount, method or
      // reservation, so there is nothing to write -- the old behaviour, kept
      // explicit rather than left as an accident of the old signature.
      const result = await confirmPayment(db, { providerIntentId: 'pi_unknown', paidAt: new Date() });

      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { field: 'providerIntentId' } } });
      expect(await db.payment.count()).toBe(0);
    });

    it('prefers the row that already exists over recording a second one', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'OXXO',
          status: 'PENDING',
          provider: 'STRIPE',
          providerIntentId: 'pi_already_here',
        },
      });

      const confirmed = await confirmPayment(db, {
        providerIntentId: 'pi_already_here',
        paidAt: new Date(),
        // Deliberately disagrees with the row above: the row wins.
        recordIfMissing: {
          reservationId: reservation.id,
          amountCents: 999_999,
          method: 'CARD',
          provider: 'STRIPE',
        },
      });

      expect(confirmed).toMatchObject({ ok: true, value: { amountCents: 150_000, method: 'OXXO' } });
      expect(await db.payment.count()).toBe(1);
    });
  });

  describe('confirmPaymentWithin', () => {
    it('runs inside the caller transaction, so a rollback takes the confirmation with it', async () => {
      // This is what lets the Stripe webhook put the `StripeEvent`
      // idempotency row and the money it authorises in one transaction.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'CARD',
          status: 'PENDING',
          provider: 'STRIPE',
          providerIntentId: 'pi_rolled_back',
        },
      });

      await expect(
        db.$transaction(async (tx: DbTransactionClient) => {
          const confirmed = await confirmPaymentWithin(tx, {
            providerIntentId: 'pi_rolled_back',
            paidAt: new Date(),
          });
          expect(confirmed.ok).toBe(true);
          throw new Error('caller changed its mind');
        })
      ).rejects.toThrow('caller changed its mind');

      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_rolled_back' } });
      expect(payment.status).toBe('PENDING');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
    });
  });

  describe('listPaymentsForCustomer', () => {
    it('returns only that customer payments, newest first', async () => {
      const customerId = await seedCustomer(db);
      const mine = await seedReservation(db, { customerId });
      const theirs = await seedReservation(db);

      for (const amountCents of [1_000, 2_000]) {
        await db.$transaction((tx) =>
          recordPayment(tx, {
            reservationId: mine.id,
            amountCents,
            method: 'CASH',
            status: 'SUCCEEDED',
            provider: 'MANUAL',
          })
        );
      }
      await db.$transaction((tx) =>
        recordPayment(tx, {
          reservationId: theirs.id,
          amountCents: 9_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        })
      );

      const listed = await listPaymentsForCustomer(db, customerId);

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value).toHaveLength(2);
      expect(listed.value.map((payment) => payment.amountCents)).toEqual([2_000, 1_000]);
      expect(listed.value.every((payment) => payment.reservationId === mine.id)).toBe(true);
    });

    it('returns an empty list for a customer who has paid nothing', async () => {
      const customerId = await seedCustomer(db);

      const listed = await listPaymentsForCustomer(db, customerId);

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value).toEqual([]);
    });
  });

  describe('suggestedMonthlyForReservation', () => {
    /** The first of the month, `months` months ahead, in the organisation's zone. */
    function deadlineMonthsAhead(months: number): Date {
      const day = DateTime.now().setZone(TIME_ZONE).startOf('month').plus({ months });
      // `payment_deadline` is a `@db.Date` column: Prisma stores the calendar
      // day at UTC midnight.
      return new Date(`${day.toISODate()}T00:00:00.000Z`);
    }

    it('splits the balance across the month-starts left before the deadline', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 1_000_000,
        paidCents: 0,
        paymentDeadline: deadlineMonthsAhead(3),
      });

      const suggested = await suggestedMonthlyForReservation(db, reservation.id);

      expect(suggested.ok).toBe(true);
      if (!suggested.ok) return;
      // 10,000.00 over three month-starts: 3,333.33 rounded up to 3,334.00.
      expect(suggested.value).toBe(333_400);
    });

    it('counts the deadline month itself, which the raw UTC instant would drop', async () => {
      // `payment_deadline` is a calendar date, not an instant. Stored as UTC
      // midnight of the 1st and read in a zone behind UTC it lands on the last
      // day of the *previous* month, so the final payment opportunity would
      // silently disappear: 200,000 over two months reads as 200,000 over one.
      const reservation = await seedReservation(db, {
        totalPriceCents: 200_000,
        paymentDeadline: deadlineMonthsAhead(2),
      });

      const suggested = await suggestedMonthlyForReservation(db, reservation.id);

      expect(suggested.ok).toBe(true);
      if (!suggested.ok) return;
      expect(suggested.value).toBe(100_000);
    });

    it('drops to what is left once payments have been recorded', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 1_000_000,
        paidCents: 700_000,
        paymentDeadline: deadlineMonthsAhead(3),
      });

      const suggested = await suggestedMonthlyForReservation(db, reservation.id);

      expect(suggested.ok).toBe(true);
      if (!suggested.ok) return;
      expect(suggested.value).toBe(100_000);
    });

    it('suggests nothing for a settled reservation', async () => {
      const reservation = await seedReservation(db, {
        totalPriceCents: 500_000,
        paidCents: 500_000,
        paymentDeadline: deadlineMonthsAhead(3),
      });

      const suggested = await suggestedMonthlyForReservation(db, reservation.id);

      expect(suggested.ok).toBe(true);
      if (!suggested.ok) return;
      expect(suggested.value).toBe(0);
    });

    it('fails for a reservation that does not exist', async () => {
      const suggested = await suggestedMonthlyForReservation(
        db,
        '11111111-1111-1111-1111-111111111111'
      );

      expect(suggested.ok).toBe(false);
      if (suggested.ok) return;
      expect(suggested.error.code).toBe('NOT_FOUND');
    });

    it('is recalculated on every read and never stored', async () => {
      const columns = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = ${TEST_SCHEMA}
          AND table_name IN ('reservations', 'payments')
      `;

      expect(columns.length).toBeGreaterThan(0);
      const stored = columns.filter((column) => /monthly|instal|mensual/i.test(column.column_name));
      expect(stored).toEqual([]);
    });
  });
});
