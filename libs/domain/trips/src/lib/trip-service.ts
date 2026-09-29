import type { Db } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { requirePermission, type Actor } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';
import { availableSeats } from './capacity';
import { slugify } from './slug';
import { canTransition, type TripStatus } from './trip-status';

export interface TripTranslationInput {
  locale: 'es' | 'en';
  name: string;
  description: string;
  itinerary: string;
  includes: string;
  excludes: string;
}

export interface CreateTripInput {
  departureDate: Date;
  returnDate: Date;
  paymentDeadline: Date;
  totalCapacity: number;
  preSoldSeats: number;
  holdTtlHours: number;
  minimumDepositCents: number;
  marginMode: 'PERCENTAGE' | 'FIXED_TOTAL' | 'FIXED_PER_SEAT';
  marginValue: number;
  translations: TripTranslationInput[];
  /** Hot start: past dates, pre-sold seats and a non-DRAFT initial status. Requires `data.backfill`. */
  isBackfilled: boolean;
  initialStatus?: TripStatus;
}

export type UpdateTripInput = Omit<CreateTripInput, 'isBackfilled' | 'initialStatus'>;

export interface TripDto {
  id: string;
  slug: string;
  status: TripStatus;
  departureDate: Date;
  returnDate: Date;
  paymentDeadline: Date;
  totalCapacity: number;
  preSoldSeats: number;
  availableSeats: number;
  holdTtlHours: number;
  minimumDepositCents: number;
  budgetTotalCents: number;
  marginMode: CreateTripInput['marginMode'];
  marginValue: number;
  pricePerSeatCents: number;
  priceMode: 'AUTO' | 'MANUAL';
  publishedAt: Date | null;
  isBackfilled: boolean;
  translations: TripTranslationInput[];
  images: { id: string; storageKey: string; position: number; isCover: boolean; altText: string | null }[];
}

export interface TripSummaryDto {
  id: string;
  slug: string;
  status: TripStatus;
  name: string;
  departureDate: Date;
  totalCapacity: number;
  availableSeats: number;
  pricePerSeatCents: number;
}

const TRIP_SHAPE = {
  translations: true,
  images: { orderBy: { position: 'asc' } },
} as const;

/**
 * Stub for Phase 2. Phase 1 has no `Reservation` model yet, so this always
 * reports zero commitments; the real queries against `Reservation` (ACTIVE
 * status and live HELD rows within their TTL) land with the reservations
 * domain task. Every caller below already routes through this function so
 * that swap is the only change needed later.
 */
async function committedSeats(_db: Db, _tripId: string) {
  return { activeReservations: 0, liveHolds: 0 };
}

async function toDto(db: Db, tripId: string): Promise<TripDto> {
  const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId }, include: TRIP_SHAPE });
  const committed = await committedSeats(db, tripId);
  return {
    id: trip.id,
    slug: trip.slug,
    status: trip.status,
    departureDate: trip.departureDate,
    returnDate: trip.returnDate,
    paymentDeadline: trip.paymentDeadline,
    totalCapacity: trip.totalCapacity,
    preSoldSeats: trip.preSoldSeats,
    availableSeats: availableSeats({
      totalCapacity: trip.totalCapacity,
      preSoldSeats: trip.preSoldSeats,
      ...committed,
    }),
    holdTtlHours: trip.holdTtlHours,
    minimumDepositCents: trip.minimumDepositCents,
    budgetTotalCents: trip.budgetTotalCents,
    marginMode: trip.marginMode,
    marginValue: trip.marginValue,
    pricePerSeatCents: trip.pricePerSeatCents,
    priceMode: trip.priceMode,
    publishedAt: trip.publishedAt,
    isBackfilled: trip.isBackfilled,
    translations: trip.translations.map((translation) => ({
      locale: translation.locale,
      name: translation.name,
      description: translation.description,
      itinerary: translation.itinerary,
      includes: translation.includes,
      excludes: translation.excludes,
    })),
    images: trip.images.map((image) => ({
      id: image.id,
      storageKey: image.storageKey,
      position: image.position,
      isCover: image.isCover,
      altText: image.altText,
    })),
  };
}

function validateDates(input: {
  departureDate: Date;
  returnDate: Date;
  paymentDeadline: Date;
}): Result<null> {
  if (input.returnDate < input.departureDate) {
    return fail('VALIDATION_FAILED', { field: 'returnDate' });
  }
  if (input.paymentDeadline > input.departureDate) {
    return fail('VALIDATION_FAILED', { field: 'paymentDeadline' });
  }
  return ok(null);
}

function validateCapacity(totalCapacity: number, preSoldSeats: number): Result<null> {
  if (totalCapacity <= 0) return fail('INVALID_CAPACITY', { field: 'totalCapacity' });
  if (preSoldSeats < 0 || preSoldSeats > totalCapacity) {
    return fail('INVALID_CAPACITY', { field: 'preSoldSeats' });
  }
  return ok(null);
}

function spanishName(translations: TripTranslationInput[]): Result<string> {
  const spanish = translations.find((translation) => translation.locale === 'es');
  // Spanish is mandatory; English is optional and falls back to Spanish when missing.
  if (!spanish) return fail('MISSING_REQUIRED_TRANSLATION', { locale: 'es' });
  return ok(spanish.name);
}

async function uniqueSlug(db: Db, base: string): Promise<string> {
  let candidate = base;
  let counter = 1;
  while (await db.trip.findUnique({ where: { slug: candidate } })) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

export async function createTrip(
  db: Db,
  actor: Actor,
  input: CreateTripInput
): Promise<Result<TripDto>> {
  const name = spanishName(input.translations);
  if (!name.ok) return name;

  const capacity = validateCapacity(input.totalCapacity, input.preSoldSeats);
  if (!capacity.ok) return capacity;

  const dates = validateDates(input);
  if (!dates.ok) return dates;

  // Hot start: a past departure date, pre-sold seats, or an initial status
  // other than DRAFT each independently require `data.backfill` -- this must
  // be `||`, not `&&`, or someone could create a past-dated trip without the
  // permission just by also leaving pre-sold seats at zero.
  const needsBackfill =
    input.departureDate < new Date() ||
    input.preSoldSeats > 0 ||
    (input.initialStatus !== undefined && input.initialStatus !== 'DRAFT');

  if (needsBackfill) {
    const allowed = requirePermission(actor, 'data.backfill');
    if (!allowed.ok) return allowed;
  }

  const slug = await uniqueSlug(db, slugify(name.value, input.departureDate));

  const trip = await db.$transaction(async (tx) => {
    const created = await tx.trip.create({
      data: {
        slug,
        status: input.initialStatus ?? 'DRAFT',
        departureDate: input.departureDate,
        returnDate: input.returnDate,
        paymentDeadline: input.paymentDeadline,
        totalCapacity: input.totalCapacity,
        preSoldSeats: input.preSoldSeats,
        holdTtlHours: input.holdTtlHours,
        minimumDepositCents: input.minimumDepositCents,
        marginMode: input.marginMode,
        marginValue: input.marginValue,
        isBackfilled: input.isBackfilled || needsBackfill,
        createdById: actor.userId,
        translations: { create: input.translations },
      },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.created',
      entityType: 'Trip',
      entityId: created.id,
      after: { slug, status: created.status, isBackfilled: created.isBackfilled },
    });
    return created;
  });

  return ok(await toDto(db, trip.id));
}

export async function updateTrip(
  db: Db,
  actor: Actor,
  tripId: string,
  input: UpdateTripInput
): Promise<Result<TripDto>> {
  const existing = await db.trip.findUnique({ where: { id: tripId }, include: TRIP_SHAPE });
  if (!existing) return fail('NOT_FOUND');

  const name = spanishName(input.translations);
  if (!name.ok) return name;

  const capacity = validateCapacity(input.totalCapacity, input.preSoldSeats);
  if (!capacity.ok) return capacity;

  const dates = validateDates(input);
  if (!dates.ok) return dates;

  const committed = await committedSeats(db, tripId);
  const alreadyTaken = existing.preSoldSeats + committed.activeReservations + committed.liveHolds;
  if (input.totalCapacity < alreadyTaken) {
    return fail('CAPACITY_BELOW_COMMITTED', { alreadyTaken });
  }

  await db.$transaction(async (tx) => {
    // The slug never changes: it may already be shared on social media.
    await tx.tripTranslation.deleteMany({ where: { tripId } });
    await tx.trip.update({
      where: { id: tripId },
      data: {
        departureDate: input.departureDate,
        returnDate: input.returnDate,
        paymentDeadline: input.paymentDeadline,
        totalCapacity: input.totalCapacity,
        preSoldSeats: input.preSoldSeats,
        holdTtlHours: input.holdTtlHours,
        minimumDepositCents: input.minimumDepositCents,
        marginMode: input.marginMode,
        marginValue: input.marginValue,
        translations: { create: input.translations },
      },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.updated',
      entityType: 'Trip',
      entityId: tripId,
      before: { totalCapacity: existing.totalCapacity, departureDate: existing.departureDate },
      after: { totalCapacity: input.totalCapacity, departureDate: input.departureDate },
    });
  });

  return ok(await toDto(db, tripId));
}

export async function changeTripStatus(
  db: Db,
  actor: Actor,
  tripId: string,
  status: TripStatus
): Promise<Result<TripDto>> {
  const trip = await db.trip.findUnique({ where: { id: tripId }, include: { images: true } });
  if (!trip) return fail('NOT_FOUND');
  if (!canTransition(trip.status, status)) {
    return fail('INVALID_STATUS_TRANSITION', { from: trip.status, to: status });
  }

  if (status === 'PUBLISHED') {
    const missing: string[] = [];
    if (trip.images.length === 0) missing.push('images');
    if (trip.pricePerSeatCents <= 0) missing.push('price');
    if (missing.length > 0) return fail('TRIP_NOT_PUBLISHABLE', { missing });
  }

  await db.$transaction(async (tx) => {
    await tx.trip.update({
      where: { id: tripId },
      data: { status, publishedAt: status === 'PUBLISHED' ? new Date() : trip.publishedAt },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.status_changed',
      entityType: 'Trip',
      entityId: tripId,
      before: { status: trip.status },
      after: { status },
    });
  });

  return ok(await toDto(db, tripId));
}

export async function getTrip(db: Db, tripId: string): Promise<Result<TripDto>> {
  const exists = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
  if (!exists) return fail('NOT_FOUND');
  return ok(await toDto(db, tripId));
}

export async function listTrips(
  db: Db,
  query: { status?: TripStatus; search?: string }
): Promise<Result<TripSummaryDto[]>> {
  const search = query.search?.trim();
  const trips = await db.trip.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(search ? { translations: { some: { name: { contains: search, mode: 'insensitive' } } } } : {}),
    },
    include: { translations: { where: { locale: 'es' } } },
    orderBy: { departureDate: 'asc' },
  });

  return ok(
    trips.map((trip) => ({
      id: trip.id,
      slug: trip.slug,
      status: trip.status,
      name: trip.translations[0]?.name ?? trip.slug,
      departureDate: trip.departureDate,
      totalCapacity: trip.totalCapacity,
      availableSeats: availableSeats({
        totalCapacity: trip.totalCapacity,
        preSoldSeats: trip.preSoldSeats,
        activeReservations: 0,
        liveHolds: 0,
      }),
      pricePerSeatCents: trip.pricePerSeatCents,
    }))
  );
}
