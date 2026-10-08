import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient } from '@rm/db';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { WebhookEvent } from '@rm/payments-stripe';
import type { PgBoss } from 'pg-boss';
import { registerCashPayment } from './counter-payment';
import { applyCreditToReservation } from './credit-service';
import type { ReviveReservation } from './revival';
import { seedCustomer, seedReservation, seedStaff } from './test-fixtures';
import { handleStripeEvent } from './webhook-handler';

/**
 * Every money path takes its row locks in one order -- see "Lock order" in
 * `payment-service.ts`. These tests pin down the two interleavings that
 * deadlocked while the webhook asked for the receipt counter before the
 * reservation (and before the customer, in its CANCELLED branch).
 *
 * The webhook's transaction is parked right after it has taken the receipt
 * counter, which every version of the code does; the other transaction then
 * starts, runs into a lock the webhook holds, and the webhook is released.
 * With one global order the second transaction simply waits; with the old
 * order each held what the other wanted and PostgreSQL aborted one of them.
 */

const db = withTestDb();

let queue: PgBoss;
let staffId: string;

/** A promise plus the handle that settles it, used to pin down an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where a proxied transaction parks: after a raw statement containing `sql`, or after `model.operation`. */
type PausePoint = { sql: string } | { model: 'reservation'; operation: 'update' };

/**
 * Wraps a real client so that, inside its transactions, the first call that
 * matches `point` waits on `pause` once it has run -- while its row locks
 * (and every lock taken before it) are still held. `reached` resolves when
 * the transaction gets there.
 */
function clientPausingAfter(client: Db, point: PausePoint, pause: Promise<void>, reached: () => void): Db {
  const forward = (target: object, property: string | symbol) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };
  let paused = false;
  const parkOnce = async () => {
    if (paused) return;
    paused = true;
    reached();
    await pause;
  };

  const pausingTransactionClient = (tx: DbTransactionClient): DbTransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        if ('sql' in point && property === '$queryRaw') {
          const queryRaw = forward(target, property) as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const result = await queryRaw(strings, ...values);
            if (strings.join('?').includes(point.sql)) await parkOnce();
            return result;
          };
        }
        if ('model' in point && property === point.model) {
          const model = Reflect.get(target, property) as object;
          return new Proxy(model, {
            get(delegate, operation) {
              if (operation !== point.operation) return forward(delegate, operation);
              const call = forward(delegate, operation) as (...args: unknown[]) => Promise<unknown>;
              return async (...args: unknown[]) => {
                const result = await call(...args);
                await parkOnce();
                return result;
              };
            },
          });
        }
        return forward(target, property);
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

function succeeded(providerIntentId: string): WebhookEvent {
  return {
    id: `evt_${providerIntentId}`,
    type: 'payment_intent.succeeded',
    occurredAt: new Date(),
    payload: { stub: true },
    intent: { providerIntentId, amountCents: 50_000, method: 'OXXO' },
  };
}

async function seedPendingPayment(reservationId: string, providerIntentId: string, amountCents: number): Promise<void> {
  await db.payment.create({
    data: { reservationId, amountCents, method: 'OXXO', status: 'PENDING', provider: 'STRIPE', providerIntentId },
  });
}

/**
 * Runs the webhook until it reaches `point`, starts `other`, gives it time to
 * block on a lock, then lets the webhook finish. Both outcomes are returned
 * settled, so a deadlock shows up as a rejection rather than as an unhandled
 * error.
 */
async function webhookThenOther<T>(
  event: WebhookEvent,
  other: () => Promise<T>,
  point: PausePoint = { sql: 'UPDATE receipt_counters' }
) {
  const gate = deferred();
  const reached = deferred();
  const webhook = handleStripeEvent(clientPausingAfter(db, point, gate.promise, reached.resolve), queue, event);
  await reached.promise;

  const second = other();
  // Long enough for the second transaction to reach the lock it waits on,
  // well under PostgreSQL's 1 s deadlock_timeout.
  await settle(300);
  gate.resolve();

  // A rejection is reduced to its message, so a failing assertion shows
  // *why* (a deadlock reads as "deadlock detected") instead of "…(1)".
  const outcomes = await Promise.allSettled([webhook, second]);
  return outcomes.map((outcome) =>
    outcome.status === 'fulfilled'
      ? outcome
      : { status: 'rejected' as const, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }
  );
}

/** The rejection message of a settled outcome, or `null` when it fulfilled: a failing check prints *why*. */
function failureOf(outcome: { status: string; reason?: string }): string | null {
  return outcome.status === 'rejected' ? (outcome.reason ?? 'rejected') : null;
}

describe('one lock order for every money path', () => {
  beforeAll(async () => {
    await prepareTestDb();
    queue = await withTestQueue();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    staffId = await seedStaff(db);
  });

  afterAll(async () => {
    await closeTestQueue();
    await closeTestDb();
  });

  it('lets cash at the counter and a Stripe confirmation on the same reservation both finish', async () => {
    const reservation = await seedReservation(db, staffId, {
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: 100_000,
    });
    await seedPendingPayment(reservation.id, 'pi_webhook', 50_000);

    const [webhook, cash] = await webhookThenOther(succeeded('pi_webhook'), () =>
      registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 30_000, actorId: staffId })
    );

    expect(failureOf(webhook)).toBeNull();
    expect(failureOf(cash)).toBeNull();
    expect(webhook).toEqual({ status: 'fulfilled', value: { ok: true, value: null } });
    expect(cash).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.paidCents).toBe(180_000);
    const receipts = await db.payment.findMany({ where: { reservationId: reservation.id, status: 'SUCCEEDED' } });
    expect(new Set(receipts.map((payment) => payment.receiptNumber)).size).toBe(2);
  });

  it("lets cash on a live HELD reservation, trip locked first, and the webhook's HELD -> ACTIVE both finish", async () => {
    // The crossing that still deadlocked after the receipt counter moved last
    // (Charlie's 40-round race). The counter route injects
    // `reviveReservationSeat`, which locks the trip and then the reservation
    // even for a live hold. The webhook updated the reservation twice, and
    // PostgreSQL re-checks the foreign keys of a row the same transaction
    // already updated: the second update took FOR KEY SHARE on the trip after
    // the reservation. `@rm/domain-payments` cannot import the real hook (it
    // is a leaf), so this stand-in takes the same two locks for a live hold;
    // `cash-vs-webhook.race.integration.spec.ts` in apps/api runs the real one.
    const liveHoldRevival: ReviveReservation = async (tx, input) => {
      await tx.$queryRaw`SELECT t.id FROM trips t JOIN reservations r ON r.trip_id = t.id WHERE r.id = ${input.reservationId}::uuid FOR UPDATE OF t`;
      await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${input.reservationId}::uuid FOR UPDATE`;
      return { ok: true, value: { outcome: 'LIVE' } };
    };
    const reservation = await seedReservation(db, staffId, {
      status: 'HELD',
      totalPriceCents: 500_000,
      minimumDepositCents: 50_000,
    });
    await seedPendingPayment(reservation.id, 'pi_deposit', 50_000);

    const [webhook, cash] = await webhookThenOther(
      succeeded('pi_deposit'),
      () => registerCashPayment(db, queue, { reservationId: reservation.id, amountCents: 30_000, actorId: staffId }, liveHoldRevival),
      // Parked between the webhook's two updates of the reservation: after
      // paid_cents moved, before HELD -> ACTIVE.
      { model: 'reservation', operation: 'update' }
    );

    expect(failureOf(webhook)).toBeNull();
    expect(failureOf(cash)).toBeNull();
    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after).toMatchObject({ status: 'ACTIVE', paidCents: 80_000, holdExpiresAt: null });
  });

  it('lets applied credit and a late payment on a cancelled reservation of the same customer both finish', async () => {
    const customerId = await seedCustomer(db);
    const live = await seedReservation(db, staffId, {
      customerId,
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: 100_000,
    });
    const cancelled = await seedReservation(db, staffId, { customerId, status: 'CANCELLED', totalPriceCents: 500_000 });
    await db.customerCreditEntry.create({
      data: { customerId, amountCents: 100_000, kind: 'ADJUSTMENT', reason: 'Cortesía' },
    });
    await seedPendingPayment(cancelled.id, 'pi_after_cancel', 50_000);

    const [webhook, credit] = await webhookThenOther(succeeded('pi_after_cancel'), () =>
      applyCreditToReservation(db, queue, { reservationId: live.id, amountCents: 30_000, actorId: staffId })
    );

    expect(failureOf(webhook)).toBeNull();
    expect(failureOf(credit)).toBeNull();
    expect(webhook).toEqual({ status: 'fulfilled', value: { ok: true, value: null } });
    expect(credit).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    const entries = await db.customerCreditEntry.findMany({ where: { customerId } });
    // 100,000 courtesy − 30,000 applied + 50,000 late money credited.
    expect(entries.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(120_000);
  });
});
