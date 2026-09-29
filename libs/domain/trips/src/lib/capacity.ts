export interface CapacityInput {
  totalCapacity: number;
  /** Seats already sold outside the system, captured during the hot start. */
  preSoldSeats: number;
  activeReservations: number;
  /** Reservations still in HELD whose hold has not expired yet. */
  liveHolds: number;
}

/**
 * Available seats are always derived, never stored. A mutable counter is
 * exactly where overselling appears when two people book the last seat in the
 * same second; callers must compute this inside a transaction that locks the
 * trip row.
 */
export function availableSeats(input: CapacityInput): number {
  return Math.max(
    0,
    input.totalCapacity - input.preSoldSeats - input.activeReservations - input.liveHolds
  );
}
