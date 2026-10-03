import { uniqueViolationIndex, type Db, type DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { repriceTrip } from '@rm/domain-costing';
import { requirePermission, type Actor } from '@rm/domain-rbac';
import { fail, isPastDate, ok, type Result } from '@rm/shared-utils';
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

const DEFAULT_TIMEZONE = 'America/Mexico_City';
const TIMEZONE_SETTING_KEY = 'organization.timezone';

/**
 * Reads the organisation's IANA timezone from `SystemSetting`, falling back
 * to the seed's own default when the row is missing -- e.g. a database that
 * has run migrations but never the seed, which is exactly this file's own
 * test suite. Calendar rules must never hardcode a timezone (a workspace-wide
 * constraint), so every date comparison below resolves it through here
 * instead of a literal.
 */
async function organizationTimeZone(db: Db): Promise<string> {
  const setting = await db.systemSetting.findUnique({ where: { key: TIMEZONE_SETTING_KEY } });
  return typeof setting?.value === 'string' ? setting.value : DEFAULT_TIMEZONE;
}

/**
 * Stub for Phase 2. Phase 1 has no `Reservation` model yet, so this always
 * reports zero commitments; the real queries against `Reservation` (ACTIVE
 * status and live HELD rows within their TTL) land with the reservations
 * domain task. Every caller in this file -- `toDto`, `listTrips`, and
 * `updateTrip`'s capacity check -- already routes through this function, so
 * that swap is the only change needed later.
 *
 * Typed to accept `DbTransactionClient` rather than `Db`, the same reasoning
 * `recordAudit` uses: `updateTrip` calls this from inside its transaction,
 * and a full `Db` is structurally assignable to `DbTransactionClient`, so
 * every call site -- inside a transaction or not -- passes its client
 * through with no cast.
 */
async function committedSeats(_db: DbTransactionClient, _tripId: string) {
  return { activeReservations: 0, liveHolds: 0 };
}

/**
 * Batched sibling of `committedSeats`, for callers that need the figure for
 * several trips at once -- today only `listTrips`. Still the Phase 1 stub:
 * returns zero for every id in `tripIds`, mirroring `committedSeats` above,
 * until the reservations domain task fills both with real queries against
 * `Reservation`. Exists so `listTrips` can issue this lookup once instead of
 * once per trip inside its `Promise.all`; `toDto` and `updateTrip` keep using
 * the single-trip `committedSeats` since they only ever need one id.
 */
async function committedSeatsForTrips(
  _db: Db,
  tripIds: string[]
): Promise<Map<string, { activeReservations: number; liveHolds: number }>> {
  return new Map(tripIds.map((tripId) => [tripId, { activeReservations: 0, liveHolds: 0 }]));
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
    // updates: exceeding capacity through pre-sold seats alone now surfaces
    // as the more specific CAPACITY_BELOW_COMMITTED (folding in real
    // reservations and holds too, once Phase 2 supplies them) instead of the
    // generic INVALID_CAPACITY that `createTrip` still returns for that same
    // shape of mistake -- a brand-new trip has no committed state yet for it
    // to be "below".
    //
    // Not guarded by `SELECT ... FOR UPDATE`: `committedSeats` is still the
    // Phase 1 stub returning zero, so there is no concurrent write for a row
    // lock to protect against today. Phase 2 must add that lock once
    // `committedSeats` reads real `Reservation` rows -- otherwise two
    // concurrent updates could each read a stale commitment count and both
    // pass this check.
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
