import {
  uniqueViolationIndex,
  type Db,
  type DbTransactionClient,
  type Payment,
  type PaymentStatus,
  type Prisma,
} from '@rm/db';
import { notifyAdmins, notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';
import { OXXO_VOUCHER_EXPIRED_FAILURE_CODE, type WebhookEvent, type WebhookPaymentIntent } from '@rm/payments-stripe';
import { fail, formatMoney, ok, type DomainError, type DomainErrorCode, type Result } from '@rm/shared-utils';
import { creditFromCancellation } from './credit-service';
import { confirmPaymentWithin } from './payment-service';

/**
 * The index behind `stripe_events`'s primary key. A violation of it is the
 * one error `handleStripeEvent` reads as "already processed" rather than as
 * a failure, so it is matched by name and never by a blanket "any unique
 * violation" catch, which would also swallow a duplicate payment intent.
 */
const STRIPE_EVENTS_PRIMARY_KEY = 'stripe_events_pkey';

/**
 * Carries a failed `Result` out of the transaction callback so the
 * transaction rolls back instead of committing.
 *
 * Returning a failed `Result` from the callback would commit everything
 * written up to that point -- including the `StripeEvent` row, which would
 * then make Stripe's retry of the same event a no-op against a database
 * that never applied it. Worse, when the failure came from a constraint
 * violation PostgreSQL has already aborted the transaction and there is
 * nothing left to commit anyway. Throwing is the only way to say "undo all
 * of this" to `$transaction`, so the error travels as an exception and is
 * turned back into a `Result` outside.
 */
class RollbackWith extends Error {
  constructor(readonly error: DomainError) {
    super(error.code);
  }
}

/** The trip's name in the recipient's own locale, falling back to whatever translation exists and finally to the slug. */
function tripNameFor(
  trip: { slug: string; translations: { locale: string; name: string }[] },
  locale: string
): string {
  const translation = trip.translations.find((candidate) => candidate.locale === locale) ?? trip.translations[0];
  return translation?.name ?? trip.slug;
}

/**
 * Why a confirmation that failed is a person's problem rather than
 * something to retry.
 *
 * Each of these means the provider took money this system cannot apply on
 * its own, and that **no number of redeliveries will change that**:
 *
 * - `NOT_FOUND` -- no reservation anywhere to attach it to (an intent
 *   created outside the app carries no `metadata.reservationId`, and a
 *   `Payment` row cannot exist without a reservation).
 * - `PAYMENT_EXCEEDS_BALANCE` -- two OXXO vouchers for the full balance can
 *   both be issued and both be paid, which `payments.md` records as an
 *   accepted consequence of a pending payment not reducing the balance.
 *   The overpayment becomes credit in Phase 2B; until then it is a person's
 *   call.
 * - `INVALID_STATUS_TRANSITION` -- the payment was already written off as
 *   `FAILED` or `EXPIRED` (typically by `expireHolds` cancelling its
 *   intent) and the money turns out to have gone through anyway. Reviving
 *   it automatically would undo a decision made elsewhere.
 *
 * So each of them escalates and then answers 200: a non-2xx would have
 * Stripe redelivering forever while the money stayed invisible. Every other
 * failure -- a `CONFLICT` from a concurrent duplicate, a malformed amount --
 * rolls the transaction back, because there a retry either helps or the
 * delivery was never valid to begin with.
 */
const NEEDS_A_HUMAN: readonly DomainErrorCode[] = [
  'NOT_FOUND',
  'PAYMENT_EXCEEDS_BALANCE',
  'INVALID_STATUS_TRANSITION',
];

/**
 * Tells whoever can act on a reservation that money arrived which the
 * system refused to apply by itself. The `StripeEvent` row written at the
 * top of the transaction is the durable evidence that the delivery
 * happened; this is the part a person actually sees.
 */
async function escalateOrphanPayment(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  amountCents: number,
  providerIntentId: string,
  reservationId?: string
): Promise<void> {
  await notifyAdmins(tx, queue, {
    reservationId,
    eventType: 'ORPHAN_PAYMENT',
    params: {
      provider: 'Stripe',
      // Staff alerts are rendered per recipient locale, but the interpolated
      // amount is one string for all of them; `es` is the organisation's.
      amount: formatMoney(amountCents, 'es'),
      intentId: providerIntentId,
    },
  });
}

/**
 * Which reservation an escalated payment belongs to, when the system knows:
 * the one its `Payment` row points at, else the one the intent names --
 * but only if that reservation really exists, since the alert row carries a
 * foreign key to it. `undefined` for money with no reservation at all.
 * Linking it is what lets staff act on PAYMENT_EXCEEDS_BALANCE or a
 * written-off payment without searching for the reservation by hand.
 */
async function reservationTheMoneyBelongsTo(
  tx: DbTransactionClient,
  intent: WebhookPaymentIntent
): Promise<string | undefined> {
  const payment = await tx.payment.findUnique({
    where: { providerIntentId: intent.providerIntentId },
    select: { reservationId: true },
  });
  if (payment) return payment.reservationId;
  if (!intent.reservationId || !UUID_PATTERN.test(intent.reservationId)) return undefined;
  const reservation = await tx.reservation.findUnique({ where: { id: intent.reservationId }, select: { id: true } });
  return reservation?.id;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything a notice about one payment needs: who to tell, what the trip is called, and where the balance stands. */
async function notificationContext(tx: DbTransactionClient, reservationId: string) {
  const reservation = await tx.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: {
      customer: { include: { user: { select: { locale: true } } } },
      trip: { select: { slug: true, translations: { select: { locale: true, name: true } } } },
    },
  });
  const locale = reservation.customer.user.locale;
  return {
    reservation,
    customerId: reservation.customerId,
    locale,
    tripName: tripNameFor(reservation.trip, locale),
    balanceCents: Math.max(0, reservation.totalPriceCents - reservation.paidCents),
  };
}

/**
 * Moves a payment out of `PENDING` without touching a single cent of the
 * balance, and reports whether it actually moved.
 *
 * The write is conditional on `status: 'PENDING'` for the same reason
 * `confirmPayment`'s own transition is: a `payment_failed` or a
 * `canceled` arriving after the money already settled must never undo a
 * `SUCCEEDED` payment. An intent with no row at all is not an error --
 * a card that was refused before we ever wrote anything down moved no
 * money and leaves nothing to record.
 */
async function closePendingPayment(
  tx: DbTransactionClient,
  providerIntentId: string,
  status: Extract<PaymentStatus, 'FAILED' | 'EXPIRED'>
): Promise<Payment | undefined> {
  const payment = await tx.payment.findUnique({ where: { providerIntentId } });
  if (!payment) return undefined;

  const closed = await tx.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status },
  });
  return closed.count === 1 ? payment : undefined;
}

/**
 * Business rule 5.5 plus the edge case of 5.3: the money is applied, and
 * then the reservation's own status decides who hears about it.
 */
async function applySucceeded(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  intent: WebhookPaymentIntent,
  occurredAt: Date
): Promise<Result<null>> {
  const confirmed = await confirmPaymentWithin(tx, {
    providerIntentId: intent.providerIntentId,
    paidAt: occurredAt,
    // Only when the intent says what it was for. See
    // `ConfirmPaymentInput.recordIfMissing`.
    recordIfMissing:
      intent.reservationId && intent.method
        ? {
            reservationId: intent.reservationId,
            amountCents: intent.amountCents,
            method: intent.method,
            provider: 'STRIPE',
          }
        : undefined,
  });

  if (!confirmed.ok) {
    if (NEEDS_A_HUMAN.includes(confirmed.error.code)) {
      await escalateOrphanPayment(
        tx,
        queue,
        intent.amountCents,
        intent.providerIntentId,
        await reservationTheMoneyBelongsTo(tx, intent)
      );
      return ok(null);
    }
    return confirmed;
  }

  const context = await notificationContext(tx, confirmed.value.reservationId);

  if (context.reservation.status === 'EXPIRED') {
    // Spec 5.3. The seat is gone and staying gone; the money is recorded
    // and both sides are told, because returning it or moving it to
    // another trip is a human decision.
    await notifyCustomer(tx, queue, {
      customerId: context.customerId,
      reservationId: context.reservation.id,
      eventType: 'PAYMENT_AFTER_EXPIRY',
      params: {
        tripName: context.tripName,
        amount: formatMoney(confirmed.value.amountCents, context.locale),
      },
    });
    await escalateOrphanPayment(
      tx,
      queue,
      confirmed.value.amountCents,
      intent.providerIntentId,
      context.reservation.id
    );
    return ok(null);
  }

  if (context.reservation.status === 'CANCELLED') {
    // Task 19: staff cancelled the reservation while a voucher or a card
    // intent was still payable (the cancellation asks the provider to cancel
    // it, but a voucher paid at the counter in that same minute, or a
    // provider outage, can still land here). Same treatment as an expired
    // hold -- money recorded, reservation left as it is, a person decides --
    // in words that say "cancelled" rather than "your hold expired".
    // Phase 2B: the money is not left in limbo -- it becomes the customer's
    // credit, like everything the reservation had received when cancelled.
    await creditFromCancellation(tx, {
      customerId: context.customerId,
      reservationId: context.reservation.id,
      amountCents: confirmed.value.amountCents,
      paymentId: confirmed.value.id,
    });
    await notifyCustomer(tx, queue, {
      customerId: context.customerId,
      reservationId: context.reservation.id,
      eventType: 'PAYMENT_AFTER_CANCELLATION',
      params: {
        tripName: context.tripName,
        amount: formatMoney(confirmed.value.amountCents, context.locale),
      },
    });
    await escalateOrphanPayment(
      tx,
      queue,
      confirmed.value.amountCents,
      intent.providerIntentId,
      context.reservation.id
    );
    return ok(null);
  }

  await notifyCustomer(tx, queue, {
    customerId: context.customerId,
    reservationId: context.reservation.id,
    eventType: 'PAYMENT_CONFIRMED',
    params: {
      tripName: context.tripName,
      amount: formatMoney(confirmed.value.amountCents, context.locale),
      balance: formatMoney(context.balanceCents, context.locale),
    },
  });
  return ok(null);
}

/**
 * A payment that did not go through. Two outcomes behind one Stripe event
 * type: an OXXO voucher that reached its deadline unpaid leaves the payment
 * `EXPIRED` and tells the customer their slip ran out; anything else (a
 * declined card, an insufficient balance) leaves it `FAILED` and tells them
 * to try again. Neither touches a cent -- a pending payment never counted
 * towards the balance in the first place (business rule 5.5).
 */
async function applyFailed(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  intent: WebhookPaymentIntent
): Promise<Result<null>> {
  const voucherExpired = intent.failureCode === OXXO_VOUCHER_EXPIRED_FAILURE_CODE;
  const payment = await closePendingPayment(tx, intent.providerIntentId, voucherExpired ? 'EXPIRED' : 'FAILED');
  if (!payment) return ok(null);

  const context = await notificationContext(tx, payment.reservationId);
  await notifyCustomer(tx, queue, {
    customerId: context.customerId,
    reservationId: payment.reservationId,
    eventType: voucherExpired ? 'VOUCHER_EXPIRED' : 'PAYMENT_FAILED',
    params: voucherExpired
      ? { tripName: context.tripName }
      : // The provider's own stable failure code, not prose: the backend
        // never invents human-facing text, and this is the string a person
        // looking the payment up in Stripe will search for.
        { tripName: context.tripName, reason: intent.failureCode ?? 'unknown' },
  });
  return ok(null);
}

/**
 * An intent cancelled at the provider. This is the event `expireHolds`
 * causes when it cancels the pending intents of a hold it has just expired
 * (Task 9), so it is expected traffic rather than an anomaly: the payment
 * becomes `EXPIRED`, no balance moves, and nobody is notified -- the
 * customer already received their `HOLD_EXPIRED` notice from the job that
 * caused this.
 */
async function applyCanceled(tx: DbTransactionClient, intent: WebhookPaymentIntent): Promise<Result<null>> {
  await closePendingPayment(tx, intent.providerIntentId, 'EXPIRED');
  return ok(null);
}

async function applyEvent(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  event: WebhookEvent
): Promise<Result<null>> {
  // Every branch below needs the Payment Intent. A `payment_intent.*` event
  // that arrived without one is malformed, not merely uninteresting.
  const intent = event.intent;

  switch (event.type) {
    case 'payment_intent.succeeded':
      if (!intent) return fail('VALIDATION_FAILED', { field: 'intent' });
      return applySucceeded(tx, queue, intent, event.occurredAt);
    case 'payment_intent.payment_failed':
      if (!intent) return fail('VALIDATION_FAILED', { field: 'intent' });
      return applyFailed(tx, queue, intent);
    case 'payment_intent.canceled':
      if (!intent) return fail('VALIDATION_FAILED', { field: 'intent' });
      return applyCanceled(tx, intent);
    default:
      // An event type this system does not act on. Stripe sends hundreds of
      // them down one endpoint and retries anything that is not a 2xx, so
      // this answers ok and does nothing at all.
      return ok(null);
  }
}

/**
 * Applies one **already-verified** Stripe webhook event, idempotently
 * (spec 5.5, 7).
 *
 * The signature is checked before this is ever called -- by
 * `PaymentProvider.verifyWebhook`, at the HTTP edge, over the exact bytes
 * Stripe sent. By the time an event reaches here it is known to come from
 * Stripe; what is *not* known is whether we have seen it before.
 *
 * **The ordering inside the transaction is the whole point.** The
 * `StripeEvent` row is inserted **first**, before any effect, and a
 * violation of its primary key means this event has already been processed,
 * so the handler returns with nothing done. That insert *is* the lock:
 *
 * - Done last, two simultaneous deliveries both pass "have I seen this?"
 *   and both apply the money before either writes its row.
 * - Done outside the transaction, a crash between the insert and the effect
 *   leaves an event marked processed that never was -- and Stripe's retry,
 *   seeing the row, would discard the only delivery that could have fixed
 *   it.
 * - Done first and inside, the second of two concurrent deliveries blocks on
 *   the primary key index until the first commits or rolls back, and then
 *   either finds the row (discard, nothing applied twice) or inserts its own
 *   (the first rolled back, so applying is exactly right).
 *
 * **A duplicate is not an error.** It answers `ok(null)`, so the route
 * replies 200 and Stripe stops retrying. Every non-2xx makes Stripe retry,
 * which is also why an event type this system does not handle answers
 * `ok(null)` rather than complaining.
 *
 * **A failed effect takes the `StripeEvent` row with it.** The failure
 * travels out of the callback as an exception so `$transaction` rolls back,
 * leaving nothing marked processed; Stripe's next delivery then gets a
 * clean run instead of being discarded as a duplicate of a delivery that
 * did nothing. The notices enqueued through `notifyCustomer` /
 * `notifyAdmins` are written on this same transaction (Ruling 11), so they
 * roll back with it too -- nobody is emailed about a payment that was not
 * recorded.
 */
export async function handleStripeEvent(
  db: Db,
  queue: NotificationQueue,
  event: WebhookEvent
): Promise<Result<null>> {
  try {
    return await db.$transaction(async (tx: DbTransactionClient) => {
      await tx.stripeEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });

      const applied = await applyEvent(tx, queue, event);
      if (!applied.ok) throw new RollbackWith(applied.error);
      return ok(null);
    });
  } catch (error) {
    if (uniqueViolationIndex(error) === STRIPE_EVENTS_PRIMARY_KEY) {
      // Already processed. Nothing was written by this transaction, and
      // nothing needs to be.
      return ok(null);
    }
    if (error instanceof RollbackWith) return { ok: false, error: error.error };
    // Anything else (a lost connection, a bug) is genuinely unexpected: let
    // it reach the route, which logs it and answers 500 so Stripe retries.
    throw error;
  }
}
