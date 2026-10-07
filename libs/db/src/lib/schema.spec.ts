import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDb,
  prepareTestDb,
  resetDatabase,
  uniqueViolationIndex,
  withTestDb,
} from '../testing';

const db = withTestDb();

describe('schema', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('stores a staff user with its profile', async () => {
    const user = await db.user.create({
      data: {
        email: 'ana@agency.test',
        type: 'STAFF',
        passwordHash: 'hashed',
        staffProfile: { create: { fullName: 'Ana Ruiz' } },
      },
      include: { staffProfile: true },
    });

    expect(user.staffProfile?.fullName).toBe('Ana Ruiz');
    expect(user.locale).toBe('es');
    expect(user.status).toBe('ACTIVE');
  });

  it('rejects two users with the same email', async () => {
    await db.user.create({ data: { email: 'dup@agency.test', type: 'STAFF' } });

    const error = await db.user
      .create({ data: { email: 'dup@agency.test', type: 'CUSTOMER' } })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeDefined();
    expect(error).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationIndex(error)).toBe('users_email_key');
  });

  it('rejects two translations for the same trip and locale', async () => {
    const creator = await db.user.create({ data: { email: 'c@agency.test', type: 'STAFF' } });
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2026',
        departureDate: new Date('2026-12-01'),
        returnDate: new Date('2026-12-07'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100000,
        createdById: creator.id,
      },
    });
    const translation = {
      tripId: trip.id,
      locale: 'es' as const,
      name: 'Oaxaca',
      description: 'd',
      itinerary: 'i',
      includes: 'inc',
      excludes: 'exc',
    };
    await db.tripTranslation.create({ data: translation });

    const error = await db.tripTranslation
      .create({ data: translation })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeDefined();
    expect(error).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationIndex(error)).toBe('trip_translations_trip_id_locale_key');
  });

  it('stamps a notification delivery with the reservation it is about, and clears it to null if that reservation is deleted', async () => {
    const staff = await db.user.create({ data: { email: 'staff2@agency.test', type: 'STAFF' } });
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2027',
        departureDate: new Date('2027-12-01'),
        returnDate: new Date('2027-12-07'),
        paymentDeadline: new Date('2027-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100000,
        createdById: staff.id,
      },
    });
    const customer = await db.user.create({
      data: {
        email: 'customer2@agency.test',
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
    const reservation = await db.reservation.create({
      data: {
        code: 'RM-SCHEMA1',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: trip.paymentDeadline,
        source: 'APP',
      },
    });

    const delivery = await db.notificationDelivery.create({
      data: {
        userId: customer.id,
        reservationId: reservation.id,
        eventType: 'HOLD_EXPIRING',
        channel: 'INBOX',
        renderedTitle: 't',
        renderedBody: 'b',
        status: 'SENT',
      },
    });
    expect(delivery.reservationId).toBe(reservation.id);

    // Deleting the reservation must not take the delivery history with it:
    // the row stays, only the pointer back to the (now gone) reservation clears.
    await db.reservation.delete({ where: { id: reservation.id } });

    const afterDelete = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(afterDelete.reservationId).toBeNull();
  });
});
