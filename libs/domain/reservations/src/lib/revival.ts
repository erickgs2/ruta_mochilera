import type { DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { fail, ok, type Result } from '@rm/shared-utils';
import { availableSeats, countCommittedSeats, lockTripForCapacity } from './capacity';

/**
 * Reviving a reservation whose hold ran out (Phase 2B, decision 13).
 *
 * The counter takes cash, or applies credit, for a reservation whose hold
 * already ran out -- a `HELD` past its time, or an `EXPIRED` one -- and the
 * seat comes back **if one is left**. This is the seat half of that: the money
 * half (taking the credit back, recording the payment) belongs to
 * `@rm/domain-payments`, which receives this function **injected** -- the two
 * domains do not import each other.
 */

export type ReviveOutcome =
  | { outcome: 'LIVE' }
  | { outcome: 'REVIVED'; previousStatus: 'EXPIRED' | 'HELD' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Makes a reservation live again, inside the caller's transaction.
 *
 * - `LIVE` when it already is (`ACTIVE`, or `HELD` with its hold running):
 *   nothing is written.
 * - `CANCELLED` does not revive: `INVALID_STATUS_TRANSITION`.
 * - Otherwise, under the trip's lock: the trip must still be `PUBLISHED`
 *   (`TRIP_NOT_PUBLISHED`), the customer must not hold another live
 *   reservation on it (`DUPLICATE_RESERVATION`) and a seat must be left
 *   (`TRIP_SOLD_OUT`). Every refusal happens before anything is written.
 * - The reservation becomes `HELD` with a fresh hold of the trip's own length
 *   (`hold_ttl_hours` from now). The payment that follows turns it `ACTIVE` if
 *   it covers the deposit; if not, the new hold is what the customer has.
 *
 * **Lock order: trip, reservation, customer** -- the order `createReservation`
 * and `applyPriceChange` already use. The trip comes first, which is why the
 * trip id is read without a lock (it never changes) before anything is locked.
 *
 * **The caller owns the rollback.** This writes only after every refusal, but
 * the payment that follows can still fail; the caller must throw to roll the
 * revival back with it.
 */
export async function reviveReservationSeat(
  tx: DbTransactionClient,
  input: { reservationId: string; actorId: string }
): Promise<Result<ReviveOutcome>> {
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');
  const located = await tx.reservation.findUnique({ where: { id: input.reservationId }, select: { tripId: true } });
  if (!located) return fail('NOT_FOUND');

  await lockTripForCapacity(tx, located.tripId);
  await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${input.reservationId}::uuid FOR UPDATE`;
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId } });

  const now = new Date();
  if (reservation.status === 'ACTIVE') return ok({ outcome: 'LIVE' });
  if (reservation.status === 'CANCELLED') return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
  if (reservation.status === 'HELD' && reservation.holdExpiresAt && reservation.holdExpiresAt > now) {
    return ok({ outcome: 'LIVE' });
  }
  const previousStatus = reservation.status === 'EXPIRED' ? 'EXPIRED' : 'HELD';

  const trip = await tx.trip.findUniqueOrThrow({ where: { id: reservation.tripId } });
  if (trip.status !== 'PUBLISHED') return fail('TRIP_NOT_PUBLISHED', { status: trip.status });

  // Under the trip lock every other booking of this trip is waiting, so this
  // check cannot be raced; the partial unique index stays as the net.
  const another = await tx.reservation.findFirst({
    where: {
      tripId: reservation.tripId,
      customerId: reservation.customerId,
      status: { in: ['HELD', 'ACTIVE'] },
      id: { not: reservation.id },
    },
    select: { id: true },
  });
  if (another) return fail('DUPLICATE_RESERVATION');

  // This reservation does not count yet (its hold is over), so a seat left
  // is a seat it can take.
  const committed = await countCommittedSeats(tx, reservation.tripId);
  const seats = availableSeats({ totalCapacity: trip.totalCapacity, preSoldSeats: trip.preSoldSeats, ...committed });
  if (seats < 1) return fail('TRIP_SOLD_OUT');

  const holdExpiresAt = new Date(now.getTime() + trip.holdTtlHours * HOUR_MS);
  await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'HELD', holdExpiresAt } });

  await recordAudit(tx, {
    actorUserId: input.actorId,
    action: 'reservation.revived',
    entityType: 'Reservation',
    entityId: reservation.id,
    before: { status: reservation.status, holdExpiresAt: reservation.holdExpiresAt?.toISOString() ?? null },
    after: { status: 'HELD', holdExpiresAt: holdExpiresAt.toISOString() },
  });

  return ok({ outcome: 'REVIVED', previousStatus });
}
