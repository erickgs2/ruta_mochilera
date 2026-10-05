import type { Db } from '@rm/db';
import { availableSeats, countCommittedSeats, countCommittedSeatsForTrips } from '@rm/domain-reservations';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { TripTranslationInput } from './trip-service';

/**
 * A gallery photo as it is shown to an anonymous visitor -- identical in
 * shape to the staff-facing `TripImageDto` (`trip-image-service.ts`), minus
 * `tripId`: a public response is already scoped to one trip, so repeating
 * its id on every image would be dead weight on every payload. Declared
 * locally rather than imported so this file carries no dependency on
 * `trip-image-service.ts` for a shape it narrows anyway; `url` is computed
 * at the HTTP boundary the same way it is for the staff endpoints (see
 * `withImageUrls` in `apps/api/src/lib/http/trip-response.ts`), never here.
 */
export interface PublicTripImageDto {
  id: string;
  storageKey: string;
  position: number;
  isCover: boolean;
  altText: string | null;
}

/**
 * The public trip catalogue's own response shapes -- deliberately narrower
 * than `TripDto`/`TripSummaryDto`. These two are served to the open
 * internet with **no authentication at all** (`GET /api/v1/public/trips`
 * and `GET /api/v1/public/trips/{slug}`), so every field the agency's own
 * costing depends on -- `budgetTotalCents`, `marginMode`, `marginValue`,
 * `preSoldSeats` -- and anything naming who created the trip
 * (`createdById`) is missing on purpose, not merely unused by today's UI.
 * A field present here is a field any browser in the world can read. See
 * `public-trip-service.spec.ts`'s "never exposes internal..." tests and
 * `public-trips.integration.spec.ts` at the HTTP layer, the ones this split
 * exists to keep passing.
 */
export interface PublicTripSummaryDto {
  slug: string;
  name: string;
  departureDate: Date;
  returnDate: Date;
  pricePerSeatCents: number;
  availableSeats: number;
  images: PublicTripImageDto[];
}

export interface PublicTripDetailDto {
  slug: string;
  departureDate: Date;
  returnDate: Date;
  pricePerSeatCents: number;
  availableSeats: number;
  translations: TripTranslationInput[];
  images: PublicTripImageDto[];
}

function toPublicImage(image: {
  id: string;
  storageKey: string;
  position: number;
  isCover: boolean;
  altText: string | null;
}): PublicTripImageDto {
  return {
    id: image.id,
    storageKey: image.storageKey,
    position: image.position,
    isCover: image.isCover,
    altText: image.altText,
  };
}

/**
 * Every `PUBLISHED` trip, cheapest-dated first -- the public landing page's
 * own list. Deliberately selects only the Spanish translation for the
 * summary's `name` (the public list is a single-locale browse page; the
 * detail page below carries every translation, for when a visitor picks a
 * trip and the app needs to render it in their own locale).
 */
export async function listPublishedTrips(db: Db): Promise<Result<PublicTripSummaryDto[]>> {
  const trips = await db.trip.findMany({
    where: { status: 'PUBLISHED' },
    include: {
      translations: { where: { locale: 'es' } },
      images: { orderBy: { position: 'asc' } },
    },
    orderBy: { departureDate: 'asc' },
  });

  // Batched the same way `@rm/domain-trips`' own staff-facing `listTrips`
  // does: one grouped query for the whole page instead of one count per
  // trip.
  const committedByTripId = await countCommittedSeatsForTrips(db, trips.map((trip) => trip.id));

  const summaries = trips.map((trip) => {
    const committed = committedByTripId.get(trip.id) ?? { activeReservations: 0, liveHolds: 0 };
    return {
      slug: trip.slug,
      name: trip.translations[0]?.name ?? trip.slug,
      departureDate: trip.departureDate,
      returnDate: trip.returnDate,
      pricePerSeatCents: trip.pricePerSeatCents,
      availableSeats: availableSeats({
        totalCapacity: trip.totalCapacity,
        preSoldSeats: trip.preSoldSeats,
        ...committed,
      }),
      images: trip.images.map(toPublicImage),
    };
  });

  return ok(summaries);
}

/**
 * One trip's public detail page, by its slug.
 *
 * **A trip that exists but is not `PUBLISHED` answers the identical
 * `NOT_FOUND` as a slug that does not exist at all.** There is no "exists
 * but hidden" response: a visitor who finds (or guesses) a draft trip's
 * slug must not be able to tell it apart from a typo, the same reasoning
 * `RESERVATION_NOT_OWNED` uses one layer over in `@rm/domain-reservations`
 * for a reservation that isn't the caller's.
 */
export async function getPublishedTripBySlug(db: Db, slug: string): Promise<Result<PublicTripDetailDto>> {
  const trip = await db.trip.findUnique({
    where: { slug },
    include: { translations: true, images: { orderBy: { position: 'asc' } } },
  });
  if (!trip || trip.status !== 'PUBLISHED') return fail('NOT_FOUND');

  const committed = await countCommittedSeats(db, trip.id);

  return ok({
    slug: trip.slug,
    departureDate: trip.departureDate,
    returnDate: trip.returnDate,
    pricePerSeatCents: trip.pricePerSeatCents,
    availableSeats: availableSeats({
      totalCapacity: trip.totalCapacity,
      preSoldSeats: trip.preSoldSeats,
      ...committed,
    }),
    translations: trip.translations.map((translation) => ({
      locale: translation.locale,
      name: translation.name,
      description: translation.description,
      itinerary: translation.itinerary,
      includes: translation.includes,
      excludes: translation.excludes,
    })),
    images: trip.images.map(toPublicImage),
  });
}
