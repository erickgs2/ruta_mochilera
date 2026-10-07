import type { Db, Reservation, ReservationStatus } from '@rm/db';

/**
 * Seeds for the payments suites, written directly through Prisma.
 *
 * `@rm/domain-payments` must stay a leaf that `@rm/domain-reservations` does
 * not depend on and does not depend back upon; importing the reservation
 * service here -- even only in a test -- would put that edge in the Nx graph.
 * Not exported from the library's index.
 */
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

export async function seedStaff(client: Db): Promise<string> {
  const index = next();
  const staff = await client.user.create({
    data: { email: `staff-${index}@agency.test`, type: 'STAFF' },
  });
  return staff.id;
}

export async function seedCustomer(client: Db): Promise<string> {
  const index = next();
  const user = await client.user.create({
    data: {
      email: `customer-${index}@agency.test`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: {
          fullName: `Cliente ${index}`,
          phone: '5512345678',
          birthDate: new Date('1990-01-01'),
          origin: 'SELF_SIGNUP',
        },
      },
    },
  });
  return user.id;
}

export async function seedReservation(
  client: Db,
  staffId: string,
  overrides: {
    status?: ReservationStatus;
    totalPriceCents?: number;
    minimumDepositCents?: number;
    paidCents?: number;
    customerId?: string;
  } = {}
): Promise<Reservation> {
  const index = next();
  const customerId = overrides.customerId ?? (await seedCustomer(client));
  const trip = await client.trip.create({
    data: {
      slug: `fixture-trip-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.totalPriceCents ?? 500_000,
      createdById: staffId,
    },
  });

  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-FIX${index}`,
      tripId: trip.id,
      customerId,
      status,
      holdExpiresAt: status === 'HELD' ? new Date(Date.now() + 72 * 60 * 60 * 1000) : null,
      totalPriceCents: overrides.totalPriceCents ?? 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paidCents: overrides.paidCents ?? 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}
