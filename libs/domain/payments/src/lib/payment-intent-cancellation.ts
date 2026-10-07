import type { Db, DbTransactionClient } from '@rm/db';
import type { PaymentProvider } from '@rm/payments-stripe';

/**
 * Cancels one reservation's pending Payment Intents at the provider, after
 * the caller's transaction has committed -- never inside it: a network call
 * there would hold the row lock and could outlast the transaction timeout,
 * rolling the expiry or cancellation back (spec §5.3: a hold that expires -- or, since Task
 * 19, a reservation staff cancel -- with an outstanding OXXO voucher or an
 * unconfirmed card intent must not leave Stripe still expecting money for a
 * seat that no longer exists).
 *
 * Optional at both call sites (`expireHolds` in `apps/worker`,
 * `cancelReservation` in `@rm/domain-reservations`) so each can be exercised
 * without a provider; `createCancelPendingPaymentIntents` below is the one
 * implementation, with its tests in `apps/worker`'s `expire-holds.spec.ts`.
 * `@rm/domain-reservations` declares the same function type structurally
 * rather than importing it, so the two domains never depend on each other.
 */
export type CancelPendingPaymentIntents = (client: Db | DbTransactionClient, reservationId: string) => Promise<void>;

/**
 * Builds the `CancelPendingPaymentIntents` hook from a `PaymentProvider`
 * (Task 9, closing the gap Task 8 left open): for every `PENDING` payment
 * carrying a `providerIntentId` on this reservation, cancels it at the
 * provider.
 *
 * Lives here since Task 19, moved from `apps/worker/src/jobs/expire-holds.ts`:
 * the panel's `cancelReservation` (`@rm/domain-reservations`, wired by
 * `apps/api`) needs the very same hook, and an app cannot import another
 * app. Behaviour unchanged.
 *
 * **A cancellation failure here never blocks the reservation's own
 * expiry -- or, since Task 19, its cancellation.** This function's return type is `Promise<void>`, not
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
  return async (client, reservationId) => {
    const pendingPayments = await client.payment.findMany({
      where: { reservationId, status: 'PENDING', providerIntentId: { not: null } },
      select: { id: true, providerIntentId: true },
    });

    for (const payment of pendingPayments) {
      if (!payment.providerIntentId) continue; // excluded by the query above; narrows the type.
      const result = await paymentProvider.cancelIntent(payment.providerIntentId);
      if (!result.ok) {
        console.error('[payment-intents] failed to cancel payment intent at provider', {
          paymentId: payment.id,
          providerIntentId: payment.providerIntentId,
          reservationId,
          error: result.error,
        });
      }
    }
  };
}
