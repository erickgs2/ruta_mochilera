import { uniqueViolationIndex, type Db, type DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { repriceTrip } from '@rm/domain-costing';
import { requirePermission, type Actor } from '@rm/domain-rbac';
import {
  availableSeats,
  countCommittedSeats,
  countCommittedSeatsForTrips,
  lockTripForCapacity,
} from '@rm/domain-reservations';
import { organizationTimeZone } from '@rm/domain-settings';
import { calendarDay, fail, isPastDate, ok, type Result } from '@rm/shared-utils';
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
 * The seats a trip has already committed: `ACTIVE` reservations plus `HELD`
 * ones still inside their TTL. Counted in `@rm/domain-reservations`, which
 * owns the `Reservation` model's rules; this file only subtracts the result.
 *
 * Typed to accept `DbTransactionClient` rather than `Db`, the same reasoning
 * `recordAudit` uses: `updateTrip` calls this from inside its transaction,
 * and a full `Db` is structurally assignable to `DbTransactionClient`, so
 * every call site -- inside a transaction or not -- passes its client
 * through with no cast.
 */
async function committedSeats(db: DbTransactionClient, tripId: string) {
  return countCommittedSeats(db, tripId);
}

/**
 * Batched sibling of `committedSeats`, for callers that need the figure for
 * several trips at once -- today only `listTrips`. One grouped query for the
 * whole page instead of one per trip; `toDto` and `updateTrip` keep using the
 * single-trip form since they only ever need one id.
 */
async function committedSeatsForTrips(
  db: Db,
  tripIds: string[]
): Promise<Map<string, { activeReservations: number; liveHolds: number }>> {
  return countCommittedSeatsForTrips(db, tripIds);
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
  // The three are calendar days (`@db.Date`), compared as such: the request
  // may carry a time of day (`...T06:00:00Z`), which the column drops, so
  // comparing the raw instants would reject a payment deadline on the day of
  // departure whenever its time came later.
  if (calendarDay(input.returnDate) < calendarDay(input.departureDate)) {
    return fail('VALIDATION_FAILED', { field: 'returnDate' });
  }
  if (calendarDay(input.paymentDeadline) > calendarDay(input.departureDate)) {
    return fail('VALIDATION_FAILED', { field: 'paymentDeadline' });
  }
  return ok(null);
}

/**
 * Full capacity validation used at creation: capacity must be positive, and
 * pre-sold seats cannot be negative or exceed it. A brand-new trip has no
 * committed state yet for anything to be "below", so this is the only
 * capacity check `createTrip` needs.
 */
function validateCapacity(totalCapacity: number, preSoldSeats: number): Result<null> {
  if (totalCapacity <= 0) return fail('INVALID_CAPACITY', { field: 'totalCapacity' });
  if (preSoldSeats < 0 || preSoldSeats > totalCapacity) {
    return fail('INVALID_CAPACITY', { field: 'preSoldSeats' });
  }
  return ok(null);
}

/**
 * Structural capacity validation used at update time: capacity must be
 * positive and pre-sold seats cannot be negative. Deliberately does not
 * compare `preSoldSeats` against `totalCapacity` here -- on update, that
 * comparison is subsumed by the `CAPACITY_BELOW_COMMITTED` check inside
 * `updateTrip`'s transaction, which additionally folds in real reservations
 * and holds once Phase 2 supplies them, and which reports the more specific
 * "you can't shrink capacity below what's already committed" rather than a
 * generic invalid-input error for what is, on update, exactly that mistake.
 */
function validateCapacityStructure(totalCapacity: number, preSoldSeats: number): Result<null> {
  if (totalCapacity <= 0) return fail('INVALID_CAPACITY', { field: 'totalCapacity' });
  if (preSoldSeats < 0) return fail('INVALID_CAPACITY', { field: 'preSoldSeats' });
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

/** The unique index backing `Trip.slug` (see the `init` migration). */
const TRIP_SLUG_UNIQUE_INDEX = 'trips_slug_key';

/**
 * Detects the race `uniqueSlug`'s pre-check cannot close on its own: see the
 * retry in `createTrip`. Mirrors `role-service.ts`'s `isRoleNameConflict`.
 */
function isSlugConflict(error: unknown): boolean {
  return uniqueViolationIndex(error) === TRIP_SLUG_UNIQUE_INDEX;
}

async function insertTrip(
  db: Db,
  actor: Actor,
  input: CreateTripInput,
  slug: string,
  isBackfilled: boolean
) {
  return db.$transaction(async (tx) => {
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
        isBackfilled,
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

  const timeZone = await organizationTimeZone(db);

  // Hot start: the caller explicitly flagging the trip as backfilled, a past
  // departure date, pre-sold seats, or an initial status other than DRAFT
  // each independently require `data.backfill` -- this must be `||` across
  // every one of these, not `&&`, or (for example) someone could create a
  // past-dated trip without the permission just by also leaving pre-sold
  // seats at zero. `input.isBackfilled` is folded into the same `||` for the
  // same reason: without it, a caller could mark an ordinary future trip as
  // backfilled -- polluting the audit trail with a label the permission is
  // meant to gate -- without ever holding `data.backfill`.
  const isBackfilled =
    input.isBackfilled ||
    isPastDate(input.departureDate, new Date(), timeZone) ||
    input.preSoldSeats > 0 ||
    (input.initialStatus !== undefined && input.initialStatus !== 'DRAFT');

  if (isBackfilled) {
    const allowed = requirePermission(actor, 'data.backfill');
    if (!allowed.ok) return allowed;
  }

  const baseSlug = slugify(name.value, input.departureDate);
  let slug = await uniqueSlug(db, baseSlug);

  let trip;
  try {
    trip = await insertTrip(db, actor, input, slug, isBackfilled);
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    // Two concurrent creates for the same name and departure year can both
    // pass `uniqueSlug`'s pre-check before either has inserted, so the
    // database's unique index on `slug` is the final word, not just a
    // nice-to-have -- the same race `role-service.createRole` closes for
    // role names. Unlike a user-chosen name, though, this slug is generated
    // by us: a caller creating "Oaxaca Mágica" twice concurrently should end
    // up with two trips (`oaxaca-magica-2026` and `oaxaca-magica-2026-2`),
    // not a CONFLICT they have to retry by hand. So the chosen response is
    // to recompute `uniqueSlug` against the now-current table and retry the
    // insert once, rather than surface a user-facing conflict for something
    // nobody typed.
    slug = await uniqueSlug(db, baseSlug);
    try {
      trip = await insertTrip(db, actor, input, slug, isBackfilled);
    } catch (retryError) {
      if (!isSlugConflict(retryError)) throw retryError;
      // Colliding twice in a row against a freshly recomputed slug means a
      // much larger race than two ordinary concurrent requests (or a bug in
      // `uniqueSlug` itself) -- treated as a genuine conflict instead of
      // retried indefinitely.
      return fail('CONFLICT', { field: 'slug' });
    }
  }

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

  const capacity = validateCapacityStructure(input.totalCapacity, input.preSoldSeats);
  if (!capacity.ok) return capacity;

  const dates = validateDates(input);
  if (!dates.ok) return dates;

  const result = await db.$transaction(async (tx) => {
    // Computed inside the transaction, and against `input.preSoldSeats` --
    // the value about to be persisted -- rather than `existing.preSoldSeats`,
    // the value being replaced: pre-sold seats are a field this very call is
    // overwriting, so the floor this check enforces has to be the number
    // that will actually be true once the update commits, not a stale
    // snapshot of what it used to be.
    //
    // This subsumes the plain "pre-sold seats over capacity" check for
    // updates: exceeding capacity through pre-sold seats alone surfaces as
    // the more specific CAPACITY_BELOW_COMMITTED (folding in real
    // reservations and holds) instead of the generic INVALID_CAPACITY that
    // `createTrip` still returns for that same shape of mistake -- a
    // brand-new trip has no committed state yet for it to be "below".
    //
    // Guarded by the trip's row lock, now that `committedSeats` reads real
    // `Reservation` rows: without it this check and a concurrent reservation
    // could each read a commitment count that the other is about to
    // invalidate, and capacity would land below what is actually booked.
    await lockTripForCapacity(tx, tripId);
    const committed = await committedSeats(tx, tripId);
    const alreadyTaken = input.preSoldSeats + committed.activeReservations + committed.liveHolds;
    if (input.totalCapacity < alreadyTaken) {
      return fail('CAPACITY_BELOW_COMMITTED', { alreadyTaken });
    }

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

    // `totalCapacity` is a divisor in the per-seat price formula
    // (`calculatePricing`'s `totalCapacity`), so a change to it must
    // reprice the trip in the same transaction as the capacity write --
    // otherwise a crash between the two commits, or simply nobody touching
    // a budget item afterward, leaves `price_per_seat_cents` computed
    // against a capacity that no longer exists. See
    // `docs/business-rules/trips.md`.
    if (input.totalCapacity !== existing.totalCapacity) {
      const repriced = await repriceTrip(tx, tripId);
      if (!repriced.ok) return repriced;
    }

    return ok(null);
  });

  if (!result.ok) return result;

  return ok(await toDto(db, tripId));
}

/**
 * Cancelling a trip is gated on its own permission, separate from every
 * other transition: `trip.publish` covers PUBLISHED/IN_PROGRESS/COMPLETED,
 * `trip.cancel` alone covers CANCELLED. Both permissions were defined in the
 * RBAC catalog from the start, but nothing enforced the split until now --
 * see `docs/business-rules/trips.md`. The route's own static permission
 * (`apps/api/.../trips/[tripId]/status/route.ts`) still requires
 * `trip.publish` as a coarse pre-check on every call to this endpoint; this
 * is the precise check that actually decides whether *this* transition is
 * allowed, the same division of labour `createTrip`'s `data.backfill` check
 * and the image gallery rules (Task 14) already use between the HTTP layer
 * and the domain.
 */
function statusChangePermission(status: TripStatus): 'trip.publish' | 'trip.cancel' {
  return status === 'CANCELLED' ? 'trip.cancel' : 'trip.publish';
}

export async function changeTripStatus(
  db: Db,
  actor: Actor,
  tripId: string,
  status: TripStatus
): Promise<Result<TripDto>> {
  const allowed = requirePermission(actor, statusChangePermission(status));
  if (!allowed.ok) return allowed;

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

  // Routed through `committedSeatsForTrips`, the batched sibling of the
  // stub `toDto` and `updateTrip` use, so the list view's numbers move in
  // lockstep with the detail view's once Phase 2 fills both stubs in -- an
  // inline `{ activeReservations: 0, liveHolds: 0 }` here would silently
  // diverge from the rest of this file the day that happens. Called once for
  // every trip in the page rather than once per trip inside the `map` below,
  // so this list does not grow a query per trip once the stub is filled.
  const committedByTripId = await committedSeatsForTrips(db, trips.map((trip) => trip.id));

  const summaries = trips.map((trip) => {
    const committed = committedByTripId.get(trip.id) ?? { activeReservations: 0, liveHolds: 0 };
    return {
      id: trip.id,
      slug: trip.slug,
      status: trip.status,
      name: trip.translations[0]?.name ?? trip.slug,
      departureDate: trip.departureDate,
      totalCapacity: trip.totalCapacity,
      availableSeats: availableSeats({
        totalCapacity: trip.totalCapacity,
        preSoldSeats: trip.preSoldSeats,
        ...committed,
      }),
      pricePerSeatCents: trip.pricePerSeatCents,
    };
  });

  return ok(summaries);
}
