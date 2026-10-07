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
        holdExpiresAt: new Date('2026-10-10T12:00:00Z'),
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });

    expect(reservation.totalPriceCents).toBe(500000);
    expect(reservation.minimumDepositCents).toBe(100000);
    expect(reservation.paidCents).toBe(0);
  });

  it('rejects two live reservations of the same customer on the same trip', async () => {
    const { trip, customer } = await createTripAndCustomer(db);

    await db.reservation.create({
      data: {
        code: 'RES-0002',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        holdExpiresAt: new Date('2026-10-10T12:00:00Z'),
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

  it('refuses a HELD reservation with no hold expiry', async () => {
    const { trip, customer } = await createTripAndCustomer(db);

    const error = await db.reservation
      .create({
        data: {
          code: 'RES-0006',
          tripId: trip.id,
          customerId: customer.id,
          status: 'HELD',
          holdExpiresAt: null,
          totalPriceCents: 500000,
          minimumDepositCents: 100000,
          paymentDeadline: new Date('2026-11-01'),
          source: 'APP',
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    // A HELD row with no expiry is a hold that never runs out, and the seat
    // counter reads it as free (`hold_expires_at > now()` is false for NULL):
    // the seat is both taken and sellable. The database refuses the state
    // instead of every reader having to remember it.
    expect(error).toMatchObject({
      code: 'P2039',
      meta: {
        driverAdapterError: {
          // 23514 is PostgreSQL's check_violation. Asserting the SQLSTATE and
          // the constraint name, rather than just "it threw", is what makes
          // this fail for the right reason: a foreign key or a NOT NULL would
          // not match.
          cause: {
            code: '23514',
            message: expect.stringContaining('reservations_held_requires_hold_expiry'),
          },
        },
      },
    });
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
        holdExpiresAt: new Date('2026-10-10T12:00:00Z'),
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });

    expect(second.status).toBe('HELD');
  });

  async function createReservation(db: Db, code: string) {
    const { trip, customer } = await createTripAndCustomer(db);
    return db.reservation.create({
      data: {
        code,
        tripId: trip.id,
        customerId: customer.id,
        status: 'ACTIVE',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'APP',
      },
    });
  }

  it('rejects two payments for the same provider intent', async () => {
    const reservation = await createReservation(db, 'RES-0007');

    await db.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents: 100000,
        method: 'OXXO',
        status: 'PENDING',
        provider: 'STRIPE',
        providerIntentId: 'pi_12345',
      },
    });

    const error = await db.payment
      .create({
        data: {
          reservationId: reservation.id,
          amountCents: 100000,
          method: 'OXXO',
          status: 'SUCCEEDED',
          provider: 'STRIPE',
          providerIntentId: 'pi_12345',
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    // One Payment Intent is one payment. Stripe retries webhook deliveries,
    // and `recordPayment`'s pre-check cannot see a row another transaction
    // has not committed yet; this index is what makes a second one
    // impossible no matter who writes it.
    expect(error).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationIndex(error)).toBe('payments_provider_intent_id_key');
  });

  it('allows many payments with no provider intent at all', async () => {
    const reservation = await createReservation(db, 'RES-0008');

    // Cash at the counter and backfilled history carry no intent id. A unique
    // index over a nullable column leaves NULLs distinct in PostgreSQL, which
    // is exactly the "unique when not null" the rule asks for.
    for (let i = 0; i < 2; i++) {
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 10000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        },
      });
    }

    expect(await db.payment.count({ where: { reservationId: reservation.id } })).toBe(2);
  });
});
