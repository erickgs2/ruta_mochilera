import type { Db } from '@rm/db';
import { notifyAdmins, type NotificationQueue } from '@rm/domain-notifications';
import { formatMoney } from '@rm/shared-utils';

/**
 * Compares every reservation's denormalized `paid_cents` against the real
 * sum of its `SUCCEEDED` payments, minus what a price decrease moved to the
 * customer's credit, (business rule, §6 of the spec) and alerts
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
  // One statement, not two queries: a single SQL statement reads one
  // snapshot, so `paid_cents` and the sum of its SUCCEEDED payments can never
  // be read on either side of a webhook that lands in between -- which, with
  // two independent reads, raised a false PAID_CENTS_MISMATCH. It also
  // returns only the drifting rows instead of every reservation.
  //
  // Phase 2B: money a price decrease moved from a reservation to its
  // customer's credit (`PRICE_DECREASE` entries) left the reservation, so it
  // is subtracted -- `paid_cents` is SUCCEEDED payments minus those.
  const drifting = await db.$queryRaw<{ id: string; code: string; paidCents: number; actualCents: bigint }[]>`
    SELECT r.id, r.code, r.paid_cents AS "paidCents", x.actual AS "actualCents"
    FROM reservations r
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                  WHERE p.reservation_id = r.id AND p.status = 'SUCCEEDED'), 0)
        - COALESCE((SELECT SUM(c.amount_cents) FROM customer_credit_entries c
                    WHERE c.reservation_id = r.id AND c.kind = 'PRICE_DECREASE'), 0) AS actual
    ) x
    WHERE r.paid_cents <> x.actual
  `;

  for (const reservation of drifting) {
    const actualCents = Number(reservation.actualCents);

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
