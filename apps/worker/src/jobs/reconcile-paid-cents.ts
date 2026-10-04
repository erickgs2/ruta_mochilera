import type { Db } from '@rm/db';
import { notifyAdmins, type NotificationQueue } from '@rm/domain-notifications';
import { formatMoney } from '@rm/shared-utils';

/**
 * Compares every reservation's denormalized `paid_cents` against the real
 * sum of its `SUCCEEDED` payments (business rule, §6 of the spec) and alerts
 * the administrators who hold `reservation.cancel` when the two disagree.
 *
 * **Deliberately does not self-heal.** A drift is a bug somewhere upstream
 * -- a payment applied without moving `paid_cents`, or the reverse -- and
 * silently overwriting `paid_cents` with the "correct" sum would erase the
 * only signal that the bug exists. This job alerts and stops; nothing here
 * ever writes `paid_cents`.
 *
 * Not idempotent by design, unlike the other two jobs: an unresolved drift
 * is meant to keep alerting every night it runs, not go quiet after the
 * first alert. Silence here would read as "fixed" to whoever is on call.
 *
 * Two queries total, not one per reservation: every `SUCCEEDED` total is
 * read in one grouped aggregate, the same shape `countCommittedSeatsForTrips`
 * (`@rm/domain-reservations`) uses to answer a whole page of trips without
 * a per-trip round trip.
 */
export async function reconcilePaidCents(db: Db, queue: NotificationQueue): Promise<void> {
  const [reservations, succeededTotals] = await Promise.all([
    db.reservation.findMany({ select: { id: true, code: true, paidCents: true } }),
    db.payment.groupBy({ by: ['reservationId'], where: { status: 'SUCCEEDED' }, _sum: { amountCents: true } }),
  ]);
  const actualByReservationId = new Map(
    succeededTotals.map((row) => [row.reservationId, row._sum.amountCents ?? 0])
  );

  for (const reservation of reservations) {
    const actualCents = actualByReservationId.get(reservation.id) ?? 0;
    if (actualCents === reservation.paidCents) continue;

    await db.$transaction((tx) =>
      notifyAdmins(tx, queue, {
        eventType: 'PAID_CENTS_MISMATCH',
        reservationId: reservation.id,
        params: {
          reservationCode: reservation.code,
          expected: formatMoney(actualCents, 'es'),
          actual: formatMoney(reservation.paidCents, 'es'),
        },
      })
    );
  }
}
