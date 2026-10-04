import type { Db } from '@rm/db';
import { notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The fraction of a trip's own hold window that must remain before this job
 * stops being silent and starts warning (business rule, Task 8 brief): a
 * quarter of `Trip.hold_ttl_hours`, floored at one hour. Not a fixed
 * duration -- a 6-hour hold and a 72-hour hold warn at very different
 * absolute times, which is the entire reason the brief insists on testing
 * both: a fixed threshold (say, "18 hours left") would warn about a 6-hour
 * hold the instant it is created.
 */
function warningThresholdMs(holdTtlHours: number): number {
  return Math.max(holdTtlHours / 4, 1) * HOUR_MS;
}

/**
 * Warns every customer whose `HELD` reservation has less than a quarter of
 * its trip's hold window left (floored at one hour), and has not already
 * reached the minimum deposit or already been warned about.
 *
 * **Idempotent.** Before sending, checks `NotificationDelivery` for an
 * existing row with this exact `reservationId` and `eventType:
 * 'HOLD_EXPIRING'`. `reservationId` (not just `customerId`) is what makes
 * this unambiguous: a customer holding two reservations at once must be
 * warned about each independently, and a plain `(customer_id, event_type)`
 * lookup could not tell those two warnings apart. This is the nullable
 * `NotificationDelivery.reservationId` column Task 8 adds (migration
 * `notification_delivery_reservation_id`) -- not anticipated by the
 * original plan.
 *
 * Calling this twice in a row is therefore a no-op the second time: nothing
 * about the reservation changes between the two calls, so the same check
 * that stops a second warning today also stops a third tomorrow once one
 * has already gone out.
 */
export async function warnExpiringHolds(db: Db, queue: NotificationQueue): Promise<void> {
  const now = new Date();
  const candidates = await db.reservation.findMany({
    where: { status: 'HELD', holdExpiresAt: { gt: now } },
    include: {
      customer: { include: { user: { select: { locale: true } } } },
      trip: { select: { slug: true, holdTtlHours: true, translations: { select: { locale: true, name: true } } } },
    },
  });

  for (const reservation of candidates) {
    if (reservation.paidCents >= reservation.minimumDepositCents) continue;

    const remainingMs = reservation.holdExpiresAt!.getTime() - now.getTime();
    if (remainingMs > warningThresholdMs(reservation.trip.holdTtlHours)) continue;

    const alreadyWarned = await db.notificationDelivery.findFirst({
      where: { reservationId: reservation.id, eventType: 'HOLD_EXPIRING' },
      select: { id: true },
    });
    if (alreadyWarned) continue;

    const translation =
      reservation.trip.translations.find((t) => t.locale === reservation.customer.user.locale) ??
      reservation.trip.translations[0];
    const tripName = translation?.name ?? reservation.trip.slug;

    await db.$transaction((tx) =>
      notifyCustomer(tx, queue, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        eventType: 'HOLD_EXPIRING',
        params: { tripName, holdExpiresAt: reservation.holdExpiresAt!.toISOString() },
      })
    );
  }
}
