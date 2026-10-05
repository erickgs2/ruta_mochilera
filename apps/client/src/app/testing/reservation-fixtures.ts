import type { components } from '@rm/api-client';
import type { SessionUser } from '@rm/auth-web';

/** Test-only fixtures shared by the reservation and payment specs. */
export type ReservationDetail = components['schemas']['ReservationDetail'];
export type PublicTripDetail = components['schemas']['PublicTripDetail'];

export function reservation(overrides: Partial<ReservationDetail> = {}): ReservationDetail {
  return {
    id: 'res-1',
    code: 'ABCD2345',
    tripId: 'trip-1',
    customerId: 'customer-1',
    status: 'HELD',
    holdExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    totalPriceCents: 500_000,
    minimumDepositCents: 100_000,
    paidCents: 0,
    creditCents: 0,
    balanceCents: 500_000,
    paymentDeadline: '2028-02-01T00:00:00.000Z',
    cancellationRequestedAt: null,
    createdAt: new Date().toISOString(),
    // Deliberately a value no client-side formula over the fields above
    // would produce: the screens must show what the API sent.
    suggestedMonthlyCents: 12_345,
    ...overrides,
  };
}

export function tripDetail(overrides: Partial<PublicTripDetail> = {}): PublicTripDetail {
  return {
    id: 'trip-1',
    slug: 'oaxaca-magica',
    departureDate: '2028-03-01T00:00:00.000Z',
    returnDate: '2028-03-07T00:00:00.000Z',
    pricePerSeatCents: 500_000,
    availableSeats: 10,
    translations: [
      { locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
    ],
    images: [],
    ...overrides,
  };
}

export function customer(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'customer-1',
    email: 'ana@example.com',
    type: 'CUSTOMER',
    locale: 'es',
    fullName: 'Ana',
    permissions: [],
    emailVerified: true,
    ...overrides,
  };
}
