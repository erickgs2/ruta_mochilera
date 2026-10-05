import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, TripStatus } from '@rm/db';
import { getPublishedTripBySlug, listPublishedTrips } from './public-trip-service';

const db = withTestDb();

let creatorId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

async function seedTrip(
  client: Db,
  overrides: {
    status?: TripStatus;
    slug?: string;
    totalCapacity?: number;
    pricePerSeatCents?: number;
    budgetTotalCents?: number;
    marginValue?: number;
    preSoldSeats?: number;
  } = {}
) {
  const index = next();
  return client.trip.create({
    data: {
      slug: overrides.slug ?? `trip-${index}`,
      status: overrides.status ?? 'PUBLISHED',
      departureDate: new Date('2027-03-01'),
      returnDate: new Date('2027-03-07'),
      paymentDeadline: new Date('2027-02-01'),
      totalCapacity: overrides.totalCapacity ?? 20,
      preSoldSeats: overrides.preSoldSeats ?? 0,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      budgetTotalCents: overrides.budgetTotalCents ?? 900_000,
      marginMode: 'PERCENTAGE',
      marginValue: overrides.marginValue ?? 2000,
      pricePerSeatCents: overrides.pricePerSeatCents ?? 150_000,
      createdById: creatorId,
      translations: {
        create: [
          { locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
          { locale: 'en', name: 'Magic Oaxaca', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
        ],
      },
      images: {
        create: [{ storageKey: 'trips/x/cover.jpg', position: 0, isCover: true, altText: 'Cover' }],
      },
    },
  });
}

describe('public trip catalogue', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(async () => {
    await resetDatabase(db);
    const creator = await db.user.create({
      data: { email: 'creator@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Creator' } } },
    });
    creatorId = creator.id;
  });
  afterAll(() => closeTestDb());

  describe('listPublishedTrips', () => {
    it('lists only PUBLISHED trips', async () => {
      await seedTrip(db, { slug: 'published-trip', status: 'PUBLISHED' });
      await seedTrip(db, { slug: 'draft-trip', status: 'DRAFT' });
      await seedTrip(db, { slug: 'cancelled-trip', status: 'CANCELLED' });

      const result = await listPublishedTrips(db);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((trip) => trip.slug)).toEqual(['published-trip']);
    });

    it('never exposes internal costing or authorship fields', async () => {
      await seedTrip(db, { budgetTotalCents: 1_000_000, marginValue: 3000, preSoldSeats: 4 });

      const result = await listPublishedTrips(db);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const summary = result.value[0] as unknown as Record<string, unknown>;
      expect(summary).not.toHaveProperty('budgetTotalCents');
      expect(summary).not.toHaveProperty('marginMode');
      expect(summary).not.toHaveProperty('marginValue');
      expect(summary).not.toHaveProperty('preSoldSeats');
      expect(summary).not.toHaveProperty('createdById');
      expect(summary).not.toHaveProperty('createdBy');
    });

    it('reports available seats net of an active reservation', async () => {
      const trip = await seedTrip(db, { totalCapacity: 10 });
      const customer = await db.user.create({
        data: {
          email: 'customer@agency.test',
          type: 'CUSTOMER',
          customerProfile: {
            create: { fullName: 'Cliente', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
          },
        },
      });
      await db.reservation.create({
        data: {
          code: 'RM-PUB1',
          tripId: trip.id,
          customerId: customer.id,
          status: 'ACTIVE',
          totalPriceCents: 150_000,
          minimumDepositCents: 100_000,
          paidCents: 150_000,
          paymentDeadline: trip.paymentDeadline,
          source: 'APP',
        },
      });

      const result = await listPublishedTrips(db);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.availableSeats).toBe(9);
    });
  });

  describe('getPublishedTripBySlug', () => {
    it('returns photos, itinerary, price and available seats for a published trip', async () => {
      await seedTrip(db, { slug: 'oaxaca-magica', pricePerSeatCents: 150_000, totalCapacity: 20 });

      const result = await getPublishedTripBySlug(db, 'oaxaca-magica');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.slug).toBe('oaxaca-magica');
      expect(result.value.pricePerSeatCents).toBe(150_000);
      expect(result.value.availableSeats).toBe(20);
      expect(result.value.images).toHaveLength(1);
      expect(result.value.images[0]?.storageKey).toBe('trips/x/cover.jpg');
      const spanish = result.value.translations.find((t) => t.locale === 'es');
      expect(spanish?.itinerary).toBe('i');
    });

    it('never exposes internal costing or authorship fields on the detail either', async () => {
      await seedTrip(db, { slug: 'oaxaca-magica', budgetTotalCents: 1_000_000, preSoldSeats: 3 });

      const result = await getPublishedTripBySlug(db, 'oaxaca-magica');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const detail = result.value as unknown as Record<string, unknown>;
      expect(detail).not.toHaveProperty('budgetTotalCents');
      expect(detail).not.toHaveProperty('marginMode');
      expect(detail).not.toHaveProperty('marginValue');
      expect(detail).not.toHaveProperty('preSoldSeats');
      expect(detail).not.toHaveProperty('createdById');
    });

    it('returns NOT_FOUND, never an empty detail, for a trip that is not published', async () => {
      await seedTrip(db, { slug: 'still-a-draft', status: 'DRAFT' });

      const result = await getPublishedTripBySlug(db, 'still-a-draft');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND for a slug that does not exist -- the same code as "not published"', async () => {
      const result = await getPublishedTripBySlug(db, 'no-such-slug');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });
});
