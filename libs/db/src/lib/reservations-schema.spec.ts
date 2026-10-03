import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDb,
  prepareTestDb,
  resetDatabase,
  uniqueViolationIndex,
  withTestDb,
} from '../testing';
import type { Db } from './client';

const db = withTestDb();

describe('reservations schema', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function createTripAndCustomer(db: Db) {
    const staff = await db.user.create({
      data: { email: 'staff@agency.test', type: 'STAFF' },
    });
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2026',
        departureDate: new Date('2026-12-01'),
        returnDate: new Date('2026-12-07'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100000,
        createdById: staff.id,
      },
    });
    const customer = await db.user.create({
      data: {
        email: 'customer@agency.test',
        type: 'CUSTOMER',
        customerProfile: {
          create: {
            fullName: 'Pat Cliente',
            phone: '5512345678',
            birthDate: new Date('1990-01-01'),
            origin: 'SELF_SIGNUP',
          },
        },
      },
    });
    return { trip, customer };
  }

  it('stores a reservation with its frozen amounts', async () => {
    const { trip, customer } = await createTripAndCustomer(db);

    const reservation = await db.reservation.create({
      data: {
        code: 'RES-0001',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });

    expect(reservation.totalPriceCents).toBe(500000);
    expect(reservation.minimumDepositCents).toBe(100000);
    expect(reservation.paidCents).toBe(0);
    expect(reservation.creditCents).toBe(0);
  });

  it('rejects two live reservations of the same customer on the same trip', async () => {
    const { trip, customer } = await createTripAndCustomer(db);

    await db.reservation.create({
      data: {
        code: 'RES-0002',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });

    const error = await db.reservation
      .create({
        data: {
          code: 'RES-0003',
          tripId: trip.id,
          customerId: customer.id,
          status: 'ACTIVE',
          totalPriceCents: 500000,
          minimumDepositCents: 100000,
          paymentDeadline: new Date('2026-11-01'),
          source: 'APP',
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeDefined();
    expect(error).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationIndex(error)).toBe('reservations_live_trip_customer_key');
  });

  it('does not let a cancelled reservation block a new one', async () => {
    const { trip, customer } = await createTripAndCustomer(db);

    await db.reservation.create({
      data: {
        code: 'RES-0004',
        tripId: trip.id,
        customerId: customer.id,
        status: 'CANCELLED',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
        cancelledAt: new Date(),
      },
    });

    const second = await db.reservation.create({
      data: {
        code: 'RES-0005',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });

    expect(second.status).toBe('HELD');
  });
});
