import type { DbTransactionClient } from '@rm/db';

/**
 * Takes the locks every money write on one reservation needs, in the order of
 * "Lock order" at the top of `payment-service.ts`: **the trip, then the
 * reservation**. Every path that moves a reservation's money calls this --
 * the Stripe webhook (`confirmPaymentWithin`, `recordPayment`), counter cash
 * (`registerCashPayment`) and applied credit (`applyCreditToReservation`) --
 * so none of them can ever hold the reservation while waiting for its trip.
 *
 * **Why the trip at all, when no money path writes it.** PostgreSQL checks a
 * row's foreign keys again when the same transaction updates that row a
 * second time: a payment moves `paid_cents` and then flips `HELD -> ACTIVE`,
 * and that second `UPDATE reservations` runs the `trip_id` check, which takes
 * `FOR KEY SHARE` on the trip. Taken there, it comes *after* the reservation
 * -- while counter cash, reviving through `reviveReservationSeat`, holds the
 * trip `FOR UPDATE` and waits for the reservation. That was the deadlock
 * (40P01, Prisma P2034) left after the receipt counter moved last
 * (`lock-order.spec.ts`; `cash-vs-webhook.race.integration.spec.ts` in
 * apps/api runs the real routes).
 *
 * `FOR KEY SHARE` is the very lock the foreign-key check would take, so this
 * changes *when* it is taken, not what is held: two payments on the same trip
 * still do not wait for each other, and anything locking the trip `FOR UPDATE`
 * (reserving, reviving, changing a price) is waited for here, before the
 * reservation, instead of after it.
 *
 * The trip id is read without a lock: a reservation never changes trip.
 * Must run inside a transaction, and the id must already be a valid UUID
 * (the callers check, so a bad id never aborts the caller's transaction on
 * the `::uuid` cast).
 */
export async function lockReservationForMoney(tx: DbTransactionClient, reservationId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT t.id FROM trips t
    WHERE t.id = (SELECT r.trip_id FROM reservations r WHERE r.id = ${reservationId}::uuid)
    FOR KEY SHARE OF t
  `;
  await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
}
