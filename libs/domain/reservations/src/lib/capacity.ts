import type { DbTransactionClient } from '@rm/db';

/**
 * The two commitment counts `availableSeats` subtracts from a trip's total:
 * see §5.1 of the Phase 2A design spec.
 */
export interface CommittedSeats {
  /** Reservations in `ACTIVE`: the deposit was covered and the seat is taken. */
  activeReservations: number;
  /**
   * Reservations still in `HELD` whose `hold_expires_at` is in the future.
   * Every HELD row has one -- a CHECK constraint guarantees it.
   */
  liveHolds: number;
}

function noCommitments(): CommittedSeats {
  return { activeReservations: 0, liveHolds: 0 };
}

/**
 * Everything the capacity formula needs: the trip's own two numbers plus the
 * commitments `countCommittedSeats` returns. Spelled as an extension of
 * `CommittedSeats` rather than repeating its two fields, so there is one
 * definition of what "committed" means and a caller can spread a count
 * straight into it.
 */
export interface CapacityInput extends CommittedSeats {
  totalCapacity: number;
  /** Seats already sold outside the system, captured during the hot start. */
  preSoldSeats: number;
}

/**
 * Available seats are always derived, never stored. A mutable counter is
 * exactly where overselling appears when two people book the last seat in the
 * same second.
 *
 * A caller that is about to *write* against this number -- taking a seat, or
 * shrinking a trip's capacity -- must compute it inside a transaction that
 * has already locked the trip row with `lockTripForCapacity`; otherwise two
 * of them read the same count and both proceed. Read-only callers (`toDto`,
 * `listTrips` in `@rm/domain-trips`) need no lock: they report a number that
 * is a snapshot by nature.
 */
export function availableSeats(input: CapacityInput): number {
  return Math.max(
    0,
    input.totalCapacity - input.preSoldSeats - input.activeReservations - input.liveHolds
  );
}

/**
 * Locks the trip's row for the rest of the caller's transaction, so that the
 * read-decide-insert sequence a reservation performs cannot interleave with
 * another one for the same trip.
 *
 * Available seats are derived, never stored (see `availableSeats` above),
 * which means two concurrent reservations would both read the same commitment
 * count, both find the last seat free, and both insert. Under READ COMMITTED
 * -- PostgreSQL's default, and what Prisma's interactive transactions use --
 * the second transaction blocks here until the first commits, and the count
 * it then reads already includes the first one's row.
 *
 * `FOR UPDATE` on a single row, not on the table: two reservations for
 * different trips never wait on each other. The id is bound as a query
 * parameter by the tagged template, never concatenated into the SQL.
 *
 * Must be called inside a transaction. A row lock taken outside one is
 * released the moment the statement ends, which would make this a no-op.
 */
export async function lockTripForCapacity(
  tx: DbTransactionClient,
  tripId: string
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
}

/**
 * Counts the seats a single trip has already committed.
 *
 * Delegates to the batched form so both answers come from one query and one
 * definition of "committed": a divergence between the detail view's number
 * and the list view's would be exactly the kind of bug nobody notices until
 * a trip oversells.
 *
 * Typed `DbTransactionClient` rather than `Db` because reservation writes
 * call it from inside their transaction, right after `lockTripForCapacity`;
 * a full `Db` is structurally assignable to it, so read-only callers such as
 * `toDto` pass their client through with no cast.
 */
export async function countCommittedSeats(
  db: DbTransactionClient,
  tripId: string
): Promise<CommittedSeats> {
  const counts = await countCommittedSeatsForTrips(db, [tripId]);
  return counts.get(tripId) ?? noCommitments();
}

/**
 * Counts the committed seats of several trips in a single query, keyed by
 * trip id.
 *
 * Every requested id is present in the returned map, including trips with no
 * reservations at all, which map to zeros rather than being absent: a caller
 * listing a page of trips reaches for `counts.get(trip.id)` for each one, and
 * an unbooked trip must not be a missing entry.
 *
 * This is what keeps `listTrips` from issuing one count per trip -- an N+1
 * that grows with the page size (see `trip-service.ts`).
 */
export async function countCommittedSeatsForTrips(
  db: DbTransactionClient,
  tripIds: readonly string[]
): Promise<Map<string, CommittedSeats>> {
  const counts = new Map(tripIds.map((tripId) => [tripId, noCommitments()]));
  if (counts.size === 0) return counts;

  // One grouped query instead of one count per status per trip. The hold
  // cutoff is the wall clock rather than the database's `now()` so that a
  // caller inside a transaction gets the same answer it would outside one:
  // PostgreSQL's `now()` is the transaction's start time, which in a long
  // interactive transaction can be meaningfully older.
  //
  // `hold_expires_at > now` also decides the NULL case, since the comparison
  // is not true for NULL -- a HELD row with no expiry would be counted as
  // free. There is no defensive branch for that here because the state
  // cannot exist: the CHECK constraint
  // `reservations_held_requires_hold_expiry` refuses it at the database
  // (see `docs/business-rules/reservations.md`).
  const rows = await db.reservation.groupBy({
    by: ['tripId', 'status'],
    where: {
      tripId: { in: [...counts.keys()] },
      OR: [{ status: 'ACTIVE' }, { status: 'HELD', holdExpiresAt: { gt: new Date() } }],
    },
    _count: { _all: true },
  });

  for (const row of rows) {
    const committed = counts.get(row.tripId);
    if (!committed) continue;
    if (row.status === 'ACTIVE') committed.activeReservations = row._count._all;
    else if (row.status === 'HELD') committed.liveHolds = row._count._all;
  }

  return counts;
}
