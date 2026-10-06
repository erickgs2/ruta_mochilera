import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { Db, DbTransactionClient, Reservation, ReservationStatus } from '@rm/db';
import {
  OXXO_VOUCHER_EXPIRED_FAILURE_CODE,
  type WebhookEvent,
  type WebhookPaymentIntent,
} from '@rm/payments-stripe';
import type { NotificationQueue } from '@rm/domain-notifications';
import { handleStripeEvent } from './webhook-handler';

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

/** Gives the other transaction time to reach the index before this one commits. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where a proxied client parks the transaction, and whether before or after the call. */
interface PausePoint {
  model: 'payment' | 'reservation' | 'stripeEvent';
  operation: string;
  when: 'before' | 'after';
}

/**
 * Wraps a real client so that one Prisma call inside the handler's own
 * transaction waits on `pause` -- before it runs, or after it has run and
 * while its row locks are still held.
 *
 * Same seam and same shape as `clientPausingAt` in
 * `payment-service.spec.ts`: the handler deliberately has no hook for
 * forcing an interleaving (a test seam in production code would be the
 * thing under test), so the seam is the injected client it already takes.
 *
 * **The pause point is deliberately not the `stripeEvent.create` call.**
 * Parking there would make the test depend on the very statement it is
 * meant to be testing the placement of: delete that statement and the
 * second delivery would simply never be released, and the test would time
 * out instead of showing the duplicate application. Parking on a write
 * that every variant performs keeps the failure honest.
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

let queue: NotificationQueue;
let staffId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

async function seedAdmin(client: Db): Promise<string> {
  // `notifyAdmins` routes to every live STAFF user holding `reservation.cancel`.
  const permission = await client.permission.create({
    data: { key: 'reservation.cancel', category: 'reservations', description: 'Cancel reservations' },
  });
  const role = await client.role.create({ data: { name: 'Agent', description: 'Front desk' } });
  await client.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const user = await client.user.create({
    data: {
      email: 'agent@agency.test',
      type: 'STAFF',
      staffProfile: { create: { fullName: 'Agente' } },
      roles: { create: { roleId: role.id } },
    },
  });
  return user.id;
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
 * Seeds trip, customer and reservation through Prisma directly, not through
 * `createReservation`: `@rm/domain-payments` must not grow an edge to
 * `@rm/domain-reservations`, not even from a test.
 */
async function seedReservation(
  client: Db,
  overrides: { status?: ReservationStatus; totalPriceCents?: number; minimumDepositCents?: number } = {}
): Promise<Reservation> {
  const index = next();
  const customerId = await seedCustomer(client);
  const trip = await client.trip.create({
    data: {
      slug: `oaxaca-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.totalPriceCents ?? 500_000,
      createdById: staffId,
      translations: {
        create: [
          { locale: 'es', name: 'Oaxaca en bici', description: 'Ruta', itinerary: 'Dia 1', includes: 'Todo', excludes: 'Nada' },
          { locale: 'en', name: 'Oaxaca by bike', description: 'Route', itinerary: 'Day 1', includes: 'All', excludes: 'None' },
        ],
      },
    },
  });

  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-WH${index}`,
      tripId: trip.id,
      customerId,
      status,
      holdExpiresAt: status === 'HELD' ? new Date(Date.now() + 72 * HOUR_MS) : null,
      totalPriceCents: overrides.totalPriceCents ?? 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paidCents: 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

async function seedPendingPayment(
  client: Db,
  reservationId: string,
  providerIntentId: string,
  amountCents = 150_000
): Promise<void> {
  await client.payment.create({
    data: { reservationId, amountCents, method: 'OXXO', status: 'PENDING', provider: 'STRIPE', providerIntentId },
  });
}

interface EventOverrides {
  id?: string;
  type?: string;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  /** `null` builds an event carrying no Payment Intent at all, as every non-`payment_intent.*` type does. */
  intent?: Partial<WebhookPaymentIntent> | null;
}

/** A `WebhookEvent` as the provider port hands it over, already verified. */
function event(overrides: EventOverrides = {}): WebhookEvent {
  const { intent, ...rest } = overrides;
  return {
    id: `evt_${next()}`,
    type: 'payment_intent.succeeded',
    occurredAt: new Date('2026-10-04T12:00:00.000Z'),
    payload: { stub: true },
    intent:
      intent === null
        ? undefined
        : { providerIntentId: 'pi_default', amountCents: 150_000, method: 'OXXO', ...intent },
    ...rest,
  };
}

/** Notification rows for one user. Every notice writes exactly two (INBOX + EMAIL). */
function noticesFor(userId: string, eventType?: string) {
  return db.notificationDelivery.count({ where: { userId, ...(eventType ? { eventType } : {}) } });
}

describe('handleStripeEvent', () => {
  beforeAll(async () => {
    await prepareTestDb();
    queue = await withTestQueue();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    sequence = 0;
    staffId = await seedAdmin(db);
  });

  afterAll(async () => {
    await closeTestQueue();
    await closeTestDb();
  });

  describe('payment_intent.succeeded', () => {
    it('records the payment, moves paid_cents and activates the reservation', async () => {
      const reservation = await seedReservation(db, { totalPriceCents: 500_000, minimumDepositCents: 100_000 });
      await seedPendingPayment(db, reservation.id, 'pi_ok');

      const result = await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_ok' } }));

      expect(result).toEqual({ ok: true, value: null });
      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_ok' } });
      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.paidAt).toEqual(new Date('2026-10-04T12:00:00.000Z'));
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(after.status).toBe('ACTIVE');
      expect(after.holdExpiresAt).toBeNull();
    });

    it('tells the customer their payment landed', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_notify');

      await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_notify' } }));

      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(2);
    });

    it('records a payment it has never seen, from the reservation on the intent metadata', async () => {
      // Stripe can deliver `succeeded` before the transaction that was going
      // to write our own PENDING row ever committed. Dropping the event
      // would leave money Stripe took with no row at all.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });

      const result = await handleStripeEvent(
        db,
        queue,
        event({
          intent: { providerIntentId: 'pi_unseen', amountCents: 200_000, method: 'CARD', reservationId: reservation.id },
        })
      );

      expect(result).toEqual({ ok: true, value: null });
      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_unseen' } });
      expect(payment).toMatchObject({ status: 'SUCCEEDED', amountCents: 200_000, method: 'CARD' });
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(200_000);
    });

    it('escalates to the administrators, and still answers ok, when there is no reservation to attach the money to', async () => {
      // Nothing can be written: a Payment needs a reservation. Answering a
      // non-2xx would only make Stripe redeliver forever, so the event is
      // recorded, a human is told, and Stripe is let go.
      const result = await handleStripeEvent(
        db,
        queue,
        event({ intent: { providerIntentId: 'pi_orphan', reservationId: undefined } })
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(await db.payment.count()).toBe(0);
      expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(2);
      expect(await db.stripeEvent.count()).toBe(1);
    });

    it('escalates, and still answers ok, when the money cannot be applied without overpaying', async () => {
      // Two OXXO vouchers for the full balance can both be issued and both
      // be paid -- `payments.md` calls that out as an accepted consequence
      // of a pending payment not reducing the balance. `recordPayment`
      // refuses the second with PAYMENT_EXCEEDS_BALANCE, and retrying never
      // changes that, so answering a non-2xx would make Stripe redeliver
      // this one forever while the money stayed invisible.
      const reservation = await seedReservation(db, { totalPriceCents: 150_000, minimumDepositCents: 100_000 });
      await seedPendingPayment(db, reservation.id, 'pi_first', 150_000);
      await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_first' } }));

      const result = await handleStripeEvent(
        db,
        queue,
        event({
          intent: {
            providerIntentId: 'pi_overpay',
            amountCents: 150_000,
            method: 'OXXO',
            reservationId: reservation.id,
          },
        })
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(2);
      // The event is on record even though no Payment row could be written.
      expect(await db.stripeEvent.count()).toBe(2);
    });

    it('escalates, and still answers ok, for money that arrived against a payment already written off', async () => {
      // `expireHolds` cancels an unpaid voucher's intent and the webhook
      // marks that payment EXPIRED -- and then the customer's payment turns
      // out to have gone through after all. `confirmPaymentWithin` refuses
      // to quietly undo a terminal status, and quite right, but the money
      // is real and a person has to see it.
      const reservation = await seedReservation(db);
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'OXXO',
          status: 'EXPIRED',
          provider: 'STRIPE',
          providerIntentId: 'pi_written_off',
        },
      });

      const result = await handleStripeEvent(
        db,
        queue,
        event({ intent: { providerIntentId: 'pi_written_off' } })
      );

      expect(result).toEqual({ ok: true, value: null });
      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_written_off' } });
      expect(payment.status).toBe('EXPIRED');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(2);
    });
  });

  describe('spec 5.3: a succeeded payment for a reservation that already expired', () => {
    async function arrange() {
      const reservation = await seedReservation(db, { status: 'EXPIRED', totalPriceCents: 500_000 });
      await seedPendingPayment(db, reservation.id, 'pi_late', 150_000);
      await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_late' } }));
      return reservation;
    }

    it('records the payment as SUCCEEDED, because the money exists and must be visible', async () => {
      const reservation = await arrange();

      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_late' } });
      expect(payment.status).toBe('SUCCEEDED');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
    });

    it('does not reactivate the reservation: giving the seat back is a human decision', async () => {
      const reservation = await arrange();

      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('EXPIRED');
      expect(after.holdExpiresAt).toBeNull();
    });

    it('notifies the customer and the administrators, each in their own words', async () => {
      const reservation = await arrange();

      // Not PAYMENT_CONFIRMED: that template quotes a remaining balance and
      // would read as "you are going" to someone whose seat was released.
      expect(await noticesFor(reservation.customerId, 'PAYMENT_AFTER_EXPIRY')).toBe(2);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(0);
      expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(2);
    });
  });

  describe('a succeeded payment for a reservation staff already cancelled (Task 19)', () => {
    async function arrange() {
      const reservation = await seedReservation(db, { status: 'CANCELLED', totalPriceCents: 500_000 });
      await seedPendingPayment(db, reservation.id, 'pi_after_cancel', 150_000);
      await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_after_cancel' } }));
      return reservation;
    }

    it('records the money without reviving the reservation', async () => {
      const reservation = await arrange();

      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_after_cancel' } });
      expect(payment.status).toBe('SUCCEEDED');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.status).toBe('CANCELLED');
      expect(after.paidCents).toBe(150_000);
    });

    it('tells the customer their reservation was cancelled, never that the payment confirmed a seat, and alerts staff', async () => {
      const reservation = await arrange();

      expect(await noticesFor(reservation.customerId, 'PAYMENT_AFTER_CANCELLATION')).toBe(2);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(0);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_AFTER_EXPIRY')).toBe(0);
      expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(2);
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('marks the payment FAILED, warns the customer and leaves the balance alone', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_declined');

      const result = await handleStripeEvent(
        db,
        queue,
        event({
          type: 'payment_intent.payment_failed',
          intent: { providerIntentId: 'pi_declined', failureCode: 'card_declined' },
        })
      );

      expect(result).toEqual({ ok: true, value: null });
      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_declined' } });
      expect(payment.status).toBe('FAILED');
      expect(payment.paidAt).toBeNull();
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(after.status).toBe('HELD');
      expect(await noticesFor(reservation.customerId, 'PAYMENT_FAILED')).toBe(2);
    });

    it('leaves an OXXO voucher that ran out of time EXPIRED, not FAILED, and says so', async () => {
      // Stripe has no dedicated voucher-expiry event: it arrives as an
      // ordinary `payment_failed` carrying this failure code.
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_voucher');

      await handleStripeEvent(
        db,
        queue,
        event({
          type: 'payment_intent.payment_failed',
          intent: { providerIntentId: 'pi_voucher', failureCode: OXXO_VOUCHER_EXPIRED_FAILURE_CODE },
        })
      );

      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_voucher' } });
      expect(payment.status).toBe('EXPIRED');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(await noticesFor(reservation.customerId, 'VOUCHER_EXPIRED')).toBe(2);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_FAILED')).toBe(0);
    });

    it('does not revive a payment that already succeeded', async () => {
      const reservation = await seedReservation(db);
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 150_000,
          method: 'CARD',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
          providerIntentId: 'pi_settled',
          paidAt: new Date(),
        },
      });

      await handleStripeEvent(
        db,
        queue,
        event({ type: 'payment_intent.payment_failed', intent: { providerIntentId: 'pi_settled' } })
      );

      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_settled' } });
      expect(payment.status).toBe('SUCCEEDED');
    });
  });

  describe('payment_intent.canceled', () => {
    it('marks the payment EXPIRED without touching the balance or writing a notice', async () => {
      // This is what arrives when `expireHolds` cancels the intent of a hold
      // it has just expired (Task 9): an expected event, not an anomaly, and
      // the customer already got their HOLD_EXPIRED notice from that job.
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_cancelled');

      const result = await handleStripeEvent(
        db,
        queue,
        event({ type: 'payment_intent.canceled', intent: { providerIntentId: 'pi_cancelled' } })
      );

      expect(result).toEqual({ ok: true, value: null });
      const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_cancelled' } });
      expect(payment.status).toBe('EXPIRED');
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(0);
      expect(await noticesFor(reservation.customerId)).toBe(0);
    });
  });

  describe('an event type this system does not handle', () => {
    it('answers ok and does nothing, because any non-2xx makes Stripe retry forever', async () => {
      const result = await handleStripeEvent(
        db,
        queue,
        event({ type: 'customer.subscription.updated', intent: null })
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(await db.payment.count()).toBe(0);
      expect(await db.notificationDelivery.count()).toBe(0);
      // Still recorded: it is the evidence that this delivery was seen.
      expect(await db.stripeEvent.count()).toBe(1);
    });
  });

  describe('idempotency', () => {
    it('writes the stripe_events row that makes the delivery idempotent', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_evt');

      await handleStripeEvent(
        db,
        queue,
        event({ id: 'evt_recorded', type: 'payment_intent.succeeded', intent: { providerIntentId: 'pi_evt' } })
      );

      const row = await db.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: 'evt_recorded' } });
      expect(row.type).toBe('payment_intent.succeeded');
    });

    it('discards a redelivery of an event it has already processed', async () => {
      const reservation = await seedReservation(db);
      await seedPendingPayment(db, reservation.id, 'pi_redelivered');
      const delivery = event({ id: 'evt_twice', intent: { providerIntentId: 'pi_redelivered' } });

      const first = await handleStripeEvent(db, queue, delivery);
      const second = await handleStripeEvent(db, queue, delivery);

      // Both answer 200: a redelivery is not an error, it is Stripe doing
      // what Stripe does.
      expect(first).toEqual({ ok: true, value: null });
      expect(second).toEqual({ ok: true, value: null });
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(await db.payment.count()).toBe(1);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(2);
    });

    it('applies two simultaneous deliveries of the same event exactly once', async () => {
      // The sequential test above only proves the second delivery sees the
      // first one's committed row. Stripe really does deliver twice at once,
      // and that is the case the ordering inside the transaction exists for:
      // the `StripeEvent` insert goes **first**, so it is the lock.
      //
      // The first delivery is parked just after it has incremented
      // `paid_cents`, with its transaction still open and its row locks
      // still held, and the second delivery runs into exactly that window.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });
      await seedPendingPayment(db, reservation.id, 'pi_concurrent');
      const delivery = event({ id: 'evt_concurrent', intent: { providerIntentId: 'pi_concurrent' } });

      const firstHasApplied = deferred();
      const firstMayCommit = deferred();
      const pausing = clientPausingAt(
        db,
        { model: 'reservation', operation: 'update', when: 'after' },
        async () => {
          firstHasApplied.resolve();
          await firstMayCommit.promise;
        }
      );

      const first = handleStripeEvent(pausing, queue, delivery);
      const second = (async () => {
        await firstHasApplied.promise;
        return handleStripeEvent(db, queue, delivery);
      })();

      // Long enough for the second delivery to reach the primary key and
      // block on it. Not load-bearing: too short and it simply finds the
      // committed row instead, and is still discarded.
      await settle(200);
      firstMayCommit.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      // Stripe must stop retrying either way.
      expect(firstResult).toEqual({ ok: true, value: null });
      expect(secondResult).toEqual({ ok: true, value: null });

      expect(await db.stripeEvent.count()).toBe(1);
      expect(await db.payment.count({ where: { status: 'SUCCEEDED' } })).toBe(1);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      // The notice has no idempotency of its own, so it is what shows a
      // second application that slipped past: one notice, not two.
      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(2);
    });

    it('never lets a simultaneous redelivery reach the effect at all, so it cannot fail on a duplicate of its own', async () => {
      // The insert is first, not merely present. With it anywhere later in
      // the transaction, this second delivery runs the whole effect, hits
      // `payments_provider_intent_id_key` with the row the first delivery
      // has not committed yet, and answers CONFLICT -- a non-2xx, for a
      // redelivery that is entirely normal. With the insert first it never
      // gets past the primary key, and answers 200 like it should.
      const reservation = await seedReservation(db, { totalPriceCents: 500_000 });
      const delivery = event({
        id: 'evt_concurrent_unseen',
        intent: { providerIntentId: 'pi_concurrent_unseen', amountCents: 150_000, method: 'CARD', reservationId: reservation.id },
      });

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

      const first = handleStripeEvent(pausing, queue, delivery);
      const second = (async () => {
        await firstHasInserted.promise;
        return handleStripeEvent(db, queue, delivery);
      })();

      await settle(200);
      firstMayCommit.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({ ok: true, value: null });
      expect(secondResult).toEqual({ ok: true, value: null });
      expect(await db.payment.count()).toBe(1);
      expect(await db.stripeEvent.count()).toBe(1);
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(after.paidCents).toBe(150_000);
      expect(await noticesFor(reservation.customerId, 'PAYMENT_CONFIRMED')).toBe(2);
    });

    it('leaves no stripe_events row behind when the effect fails, so the retry gets a clean run', async () => {
      // `pi_missing` has no payment row and no reservation on the intent, so
      // there is nothing to confirm -- but here the amount is not a whole
      // number of cents either, which `recordPayment` refuses outright.
      const reservation = await seedReservation(db);

      const result = await handleStripeEvent(
        db,
        queue,
        event({
          id: 'evt_rolled_back',
          intent: { providerIntentId: 'pi_bad_amount', amountCents: 1.5, reservationId: reservation.id },
        })
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await db.stripeEvent.count()).toBe(0);
      expect(await db.payment.count()).toBe(0);
      expect(await db.notificationDelivery.count()).toBe(0);
    });
  });
});
