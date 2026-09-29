import { describe, expect, it } from 'vitest';
import { availableSeats } from './capacity';

describe('availableSeats', () => {
  it('subtracts pre-sold seats, active reservations and live holds', () => {
    expect(availableSeats({ totalCapacity: 20, preSoldSeats: 5, activeReservations: 3, liveHolds: 2 })).toBe(10);
  });

  it('counts a trip with no commitments as fully available', () => {
    expect(availableSeats({ totalCapacity: 20, preSoldSeats: 0, activeReservations: 0, liveHolds: 0 })).toBe(20);
  });

  it('never returns a negative number', () => {
    expect(availableSeats({ totalCapacity: 5, preSoldSeats: 4, activeReservations: 3, liveHolds: 0 })).toBe(0);
  });
});
