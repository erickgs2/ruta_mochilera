import type { Db, DbTransactionClient } from '@rm/db';
import { notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';
import type { PaymentProvider } from '@rm/payments-stripe';

/**
 * Cancels this reservation's pending Stripe Payment Intents (spec §5.3: a
 * hold that expires with an outstanding OXXO voucher or an unconfirmed card
 * intent must not leave Stripe still expecting money for a seat that no
 * longer exists).
 *
 * The payments provider port did not exist yet at Task 8 -- Task 9 built it
 * and wires this parameter via `createCancelPendingPaymentIntents` below,
 * with its own tests proving the cancellation actually happens, that
 * running it twice cancels at most once, and that a provider failure never
 * blocks the reservation's own expiry. Left optional purely so a caller
 * without a `PaymentProvider` to hand (none exist today) can still call
 * `expireHolds` directly, the same honest-stub shape Phase 1 left for
 * `committedSeats`.
 */
export type CancelPendingPaymentIntents = (tx: DbTransactionClient, reservationId: string) => Promise<void>;

/**
 * Builds the `CancelPendingPaymentIntents` hook from a `PaymentProvider`
 * (Task 9, closing the gap Task 8 left open): for every `PENDING` payment
 * carrying a `providerIntentId` on this reservation, cancels it at the
 * provider.
 *
 * **A cancellation failure here never blocks the reservation's own
 * expiry.** This function's return type is `Promise<void>`, not
 * `Result<void>`, and it never throws: whatever `cancelIntent` reports is
 * only logged. The alternative -- letting a provider failure propagate and
 * abort `expireHolds`'s transaction -- would mean a Stripe outage (or any
 * other third party's) could leave a seat locked indefinitely behind a
 * hold nobody can ever expire. Letting the seat go and logging the
 * mismatch for someone to reconcile later is the only direction that keeps
 * the business running.
 *
 * **Not itself a source of double-cancellation.** This hook runs once per
 * reservation per successful expiry, because `expireHolds` only calls it
 * after its own conditional `updateMany` actually flipped the row to
 * `EXPIRED` -- a second pass over an already-`EXPIRED` reservation matches
 * no candidates and never reaches this hook again. `PaymentProvider.cancelIntent`
 * is additionally idempotent on its own (every implementation's contract
 * requires it), so even a hook invoked twice for the same intent would
 * still be safe.
 */
export function createCancelPendingPaymentIntents(paymentProvider: PaymentProvider): CancelPendingPaymentIntents {
  return async (tx, reservationId) => {
    const pendingPayments = await tx.payment.findMany({
      where: { reservationId, status: 'PENDING', providerIntentId: { not: null } },
      select: { id: true, providerIntentId: true },
    });

    for (const payment of pendingPayments) {
      if (!payment.providerIntentId) continue; // excluded by the query above; narrows the type.
      const result = await paymentProvider.cancelIntent(payment.providerIntentId);
      if (!result.ok) {
        console.error('[expire-holds] failed to cancel payment intent at provider', {
          paymentId: payment.id,
          providerIntentId: payment.providerIntentId,
          reservationId,
          error: result.error,
        });
      }
    }
  };
}

/**
 * Expires every `HELD` reservation whose `hold_expires_at` has passed
 * (business rule 5.3), one reservation per transaction.
 *
 * **Idempotent.** The write is `updateMany({ where: { id, status: 'HELD',
 * holdExpiresAt: { lt: now } } })`, not a plain `update` keyed only on
 * `id`: calling this twice in a row, or calling it while another writer is
 * mid-flight on the same row, can only ever expire a reservation once. A
 * second pass over an already-`EXPIRED` row -- or a row a concurrent
 * payment has since activated -- matches nothing and does nothing.
 *
 * **The race this guards against** (carried from Task 5's review): this
 * job reads its candidates with a plain, unlocked `findMany`, then opens one
 * transaction per candidate to write it. Nothing stops a concurrent payment
 * from activating that same reservation in the gap between the read and the
 * write. Because the write re-checks `status: 'HELD'` instead of trusting
 * the earlier read, that payment's commit -- whichever side of this job's
 * write it lands on -- is never silently undone. See
 * `expire-holds.spec.ts`'s "does not resurrect or clobber..." test, which
 * forces exactly that interleaving, and `payment-service.ts`'s matching
 * hardening on the other side of the same row.
 *
 * Available seats are derived, never stored (`@rm/domain-reservations`'s
 * `availableSeats`), so flipping the status is the only write this job owes
 * the trip's capacity count -- nothing else reads or writes a counter.
 */
export async function expireHolds(
  db: Db,
  queue: NotificationQueue,
  cancelPendingPaymentIntents?: CancelPendingPaymentIntents
): Promise<void> {
  const now = new Date();
  const candidates = await db.reservation.findMany({
    where: { status: 'HELD', holdExpiresAt: { lt: now } },
    select: { id: true },
  });

  for (const { id } of candidates) {
    await db.$transaction(async (tx: DbTransactionClient) => {
      const expired = await tx.reservation.updateMany({
        where: { id, status: 'HELD', holdExpiresAt: { lt: now } },
        data: { status: 'EXPIRED', holdExpiresAt: null },
      });
      // Lost the race for this row -- see the doc comment above.
      if (expired.count === 0) return;

      if (cancelPendingPaymentIntents) {
        await cancelPendingPaymentIntents(tx, id);
      }

      const reservation = await tx.reservation.findUniqueOrThrow({
        where: { id },
        include: {
          customer: { include: { user: { select: { locale: true } } } },
          trip: { select: { slug: true, translations: { select: { locale: true, name: true } } } },
        },
      });

      const tripName = tripNameFor(reservation.trip, reservation.customer.user.locale);

      await notifyCustomer(tx, queue, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        eventType: 'HOLD_EXPIRED',
        params: { tripName },
      });
    });
  }
}

/**
 * The trip's name in the recipient's own locale, falling back to whatever
 * translation exists and finally to the slug. A published trip always has
 * both locales (trips.md, `MISSING_REQUIRED_TRANSLATION`), so the fallbacks
 * only matter for a trip seeded directly in a test without one.
 */
function tripNameFor(
  trip: { slug: string; translations: { locale: string; name: string }[] },
  locale: string
): string {
  const translation = trip.translations.find((t) => t.locale === locale) ?? trip.translations[0];
  return translation?.name ?? trip.slug;
}
