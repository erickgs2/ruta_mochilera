import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { TripStatus } from '@rm/db';
import { GET as getPublicTripRoute } from './[slug]/route';
import { GET as listPublicTripsRoute } from './route';

const db = withTestDb();

let creatorId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

function withSlug(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function request(url: string) {
  return new Request(`http://localhost${url}`);
}

async function seedTrip(
  overrides: {
    status?: TripStatus;
    slug?: string;
  } = {}
) {
  const index = next();
  return db.trip.create({
    data: {
      slug: overrides.slug ?? `trip-${index}`,
      status: overrides.status ?? 'PUBLISHED',
      departureDate: new Date('2027-03-01'),
      returnDate: new Date('2027-03-07'),
      paymentDeadline: new Date('2027-02-01'),
      totalCapacity: 20,
      preSoldSeats: 2,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      budgetTotalCents: 900_000,
      marginMode: 'PERCENTAGE',
      marginValue: 2000,
      pricePerSeatCents: 150_000,
      createdById: creatorId,
      translations: {
        create: [
          { locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'ruta completa', includes: 'inc', excludes: 'exc' },
        ],
      },
      images: { create: [{ storageKey: 'trips/x/cover.jpg', position: 0, isCover: true, altText: 'Cover' }] },
    },
  });
}

describe('public trip catalogue endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    const creator = await db.user.create({
      data: { email: 'creator@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Creator' } } },
    });
    creatorId = creator.id;
  });
  afterAll(() => closeTestDb());

  describe('GET /api/v1/public/trips', () => {
    it('needs no authentication', async () => {
      await seedTrip();
      const response = await listPublicTripsRoute(request('/api/v1/public/trips'));
      expect(response.status).toBe(200);
    });

    it('lists only PUBLISHED trips -- a DRAFT one never appears', async () => {
      const published = await seedTrip({ slug: 'published-trip', status: 'PUBLISHED' });
      await seedTrip({ slug: 'draft-trip', status: 'DRAFT' });

      const response = await listPublicTripsRoute(request('/api/v1/public/trips'));
      const body = (await response.json()) as { slug: string }[];

      expect(body.map((trip) => trip.slug)).toEqual([published.slug]);
    });

    it('does not expose budget, margin, pre-sold seats or who created the trip', async () => {
      await seedTrip();

      const response = await listPublicTripsRoute(request('/api/v1/public/trips'));
      const body = (await response.json()) as Record<string, unknown>[];

      expect(body).toHaveLength(1);
      const trip = body[0] as Record<string, unknown>;
      expect(trip).not.toHaveProperty('budgetTotalCents');
      expect(trip).not.toHaveProperty('marginMode');
      expect(trip).not.toHaveProperty('marginValue');
      expect(trip).not.toHaveProperty('preSoldSeats');
      expect(trip).not.toHaveProperty('createdById');
      expect(trip).not.toHaveProperty('createdBy');
      expect(trip).not.toHaveProperty('priceMode');
      expect(trip).not.toHaveProperty('isBackfilled');
      expect(trip).not.toHaveProperty('status');
    });
  });

  describe('GET /api/v1/public/trips/{slug}', () => {
    it('needs no authentication', async () => {
      const trip = await seedTrip();
      const response = await getPublicTripRoute(request(`/api/v1/public/trips/${trip.slug}`), withSlug(trip.slug));
      expect(response.status).toBe(200);
    });

    it('returns photos, itinerary, price per seat and available seats for a published trip', async () => {
      const trip = await seedTrip();

      const response = await getPublicTripRoute(request(`/api/v1/public/trips/${trip.slug}`), withSlug(trip.slug));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.pricePerSeatCents).toBe(150_000);
      expect(body.availableSeats).toBe(18); // 20 total - 2 pre-sold
      expect(Array.isArray(body.images)).toBe(true);
      expect((body.images as Record<string, unknown>[])[0]?.storageKey).toBe('trips/x/cover.jpg');
      const translations = body.translations as { locale: string; itinerary: string }[];
      expect(translations.find((t) => t.locale === 'es')?.itinerary).toBe('ruta completa');
    });

    it('does not expose budget, margin, pre-sold seats or who created the trip', async () => {
      const trip = await seedTrip();

      const response = await getPublicTripRoute(request(`/api/v1/public/trips/${trip.slug}`), withSlug(trip.slug));
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).not.toHaveProperty('budgetTotalCents');
      expect(body).not.toHaveProperty('marginMode');
      expect(body).not.toHaveProperty('marginValue');
      expect(body).not.toHaveProperty('preSoldSeats');
      expect(body).not.toHaveProperty('createdById');
      expect(body).not.toHaveProperty('createdBy');
      expect(body).not.toHaveProperty('priceMode');
      expect(body).not.toHaveProperty('isBackfilled');
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('holdTtlHours');
      expect(body).not.toHaveProperty('minimumDepositCents');
    });

    it('returns 404, never an empty detail, for a trip that is not published', async () => {
      const trip = await seedTrip({ slug: 'still-draft', status: 'DRAFT' });

      const response = await getPublicTripRoute(request(`/api/v1/public/trips/${trip.slug}`), withSlug(trip.slug));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });

    it('returns 404 for a slug that does not exist', async () => {
      const response = await getPublicTripRoute(request('/api/v1/public/trips/no-such-slug'), withSlug('no-such-slug'));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });
  });
});
