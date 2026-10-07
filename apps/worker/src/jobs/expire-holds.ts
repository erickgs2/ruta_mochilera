import type { Db, DbTransactionClient } from '@rm/db';
import { notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';
import type { CancelPendingPaymentIntents } from '@rm/domain-payments';

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
    const expiredThisOne = await db.$transaction(async (tx: DbTransactionClient) => {
      const expired = await tx.reservation.updateMany({
        where: { id, status: 'HELD', holdExpiresAt: { lt: now } },
        data: { status: 'EXPIRED', holdExpiresAt: null },
      });
      // Lost the race for this row -- see the doc comment above.
      if (expired.count === 0) return false;

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
      return true;
    });

    // After the commit, never inside the transaction: a provider call there
    // would hold the row lock across a network round trip and, past
    // Prisma's transaction timeout, roll the expiry back -- a slow Stripe
    // keeping the seat locked, the one thing the hook must never cause. The
    // hook never throws; a failure is logged and reconciled by hand.
    if (expiredThisOne && cancelPendingPaymentIntents) {
      await cancelPendingPaymentIntents(db, id);
    }
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
