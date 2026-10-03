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
 * same second.
 *
 * A caller that is about to *write* against this number -- taking a seat, or
 * shrinking a trip's capacity -- must compute it inside a transaction that
 * has already locked the trip row with `lockTripForCapacity`
 * (`@rm/domain-reservations`); otherwise two of them read the same count and
 * both proceed. Read-only callers (`toDto`, `listTrips`) need no lock: they
 * report a number that is a snapshot by nature.
 */
export function availableSeats(input: CapacityInput): number {
  return Math.max(
    0,
    input.totalCapacity - input.preSoldSeats - input.activeReservations - input.liveHolds
  );
}
