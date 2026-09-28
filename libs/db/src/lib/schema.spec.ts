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
});
