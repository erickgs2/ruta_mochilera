import {
  uniqueViolationIndex,
  type Db,
  type DbTransactionClient,
  type Reservation,
  type ReservationStatus,
} from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { notifyAdmins, type NotificationQueue } from '@rm/domain-notifications';
import { organizationTimeZone } from '@rm/domain-settings';
import { fail, isPastDate, ok, type Result } from '@rm/shared-utils';
import { availableSeats, countCommittedSeats, lockTripForCapacity } from './capacity';
import { generateReservationCode } from './reservation-code';

export interface CreateReservationInput {
  tripId: string;
  customerId: string;
}

export interface ReservationDto {
  id: string;
  code: string;
  tripId: string;
  customerId: string;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  totalPriceCents: number;
  minimumDepositCents: number;
  paidCents: number;
  creditCents: number;
  /** Derived, never stored: `total_price_cents - paid_cents`, floored at zero. */
  balanceCents: number;
  paymentDeadline: Date;
  cancellationRequestedAt: Date | null;
  createdAt: Date;
}

/**
 * What a list row needs. Drops the detail-only fields (`minimumDepositCents`,
 * `creditCents`, `cancellationRequestedAt`) and carries no trip data: the
 * catalogue already serves trips, and `tripId` is what joins the two. A list
 * that reached into `TripTranslation` would guess at a screen that does not
 * exist yet and would cost a join per page.
 */
export interface ReservationSummaryDto {
  id: string;
  code: string;
  tripId: string;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  totalPriceCents: number;
  paidCents: number;
  balanceCents: number;
  paymentDeadline: Date;
  createdAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;

/** The unique index behind `Reservation.code` (see the `reservations_payments_notifications` migration). */
const RESERVATION_CODE_INDEX = 'reservations_code_key';

/**
 * The partial unique index that allows a customer exactly one `HELD` or
 * `ACTIVE` reservation per trip (same migration, written as raw SQL because
 * Prisma cannot express a partial index).
 */
const LIVE_RESERVATION_INDEX = 'reservations_live_trip_customer_key';

/** Candidate codes read before the insert; past that, the unique index decides. */
const CODE_LOOKUPS = 5;

/** How many times the whole insert is retried after a code collision. */
const CODE_INSERT_ATTEMPTS = 2;

/**
 * The two statuses that occupy a seat, and exactly the set
 * `reservations_live_trip_customer_key` is restricted to. Spread into each
 * Prisma `in` filter because the client asks for a mutable array and this
 * list is not one.
 */
const LIVE_STATUSES = ['HELD', 'ACTIVE'] as const satisfies readonly ReservationStatus[];

function balanceOf(reservation: Reservation): number {
  return Math.max(0, reservation.totalPriceCents - reservation.paidCents);
}

function toDto(reservation: Reservation): ReservationDto {
  return {
    id: reservation.id,
    code: reservation.code,
    tripId: reservation.tripId,
    customerId: reservation.customerId,
    status: reservation.status,
    holdExpiresAt: reservation.holdExpiresAt,
    totalPriceCents: reservation.totalPriceCents,
    minimumDepositCents: reservation.minimumDepositCents,
    paidCents: reservation.paidCents,
    creditCents: reservation.creditCents,
    balanceCents: balanceOf(reservation),
    paymentDeadline: reservation.paymentDeadline,
    cancellationRequestedAt: reservation.cancellationRequestedAt,
    createdAt: reservation.createdAt,
  };
}

function toSummaryDto(reservation: Reservation): ReservationSummaryDto {
  return {
    id: reservation.id,
    code: reservation.code,
    tripId: reservation.tripId,
    status: reservation.status,
    holdExpiresAt: reservation.holdExpiresAt,
    totalPriceCents: reservation.totalPriceCents,
    paidCents: reservation.paidCents,
    balanceCents: balanceOf(reservation),
    paymentDeadline: reservation.paymentDeadline,
    createdAt: reservation.createdAt,
  };
}

/**
 * Picks a code the table does not already hold.
 *
 * The loop is the normal path and the `reservations_code_key` index is the
 * final word: two concurrent creations can both read a free code before
 * either inserts, so the pre-check cannot close the race on its own -- the
 * same division of labour `trip-service.createTrip` uses for a trip's slug.
 * After `CODE_LOOKUPS` taken candidates it stops reading and lets the insert
 * try anyway; at 30^8 possible codes, reaching that point means something far
 * stranger than bad luck, and the retry in `createReservation` still covers
 * it.
 */
async function uniqueReservationCode(tx: DbTransactionClient): Promise<string> {
  let candidate = generateReservationCode();
  for (let lookup = 1; lookup < CODE_LOOKUPS; lookup++) {
    const taken = await tx.reservation.findUnique({ where: { code: candidate } });
    if (!taken) break;
    candidate = generateReservationCode();
  }
  return candidate;
}

/**
 * One attempt at the whole of §5.2, inside a single transaction.
 *
 * The order is the rule, not a style choice: the trip row is locked *first*,
 * and only then is capacity read and decided on. Counting before locking
 * leaves the window where two customers both see the last seat free and both
 * insert it. Everything that can reject the request is checked inside the
 * same transaction, so a trip unpublished (or a reservation cancelled) while
 * this one is deciding cannot slip past.
 */
async function insertReservation(
  db: Db,
  input: CreateReservationInput,
  timeZone: string
): Promise<Result<ReservationDto>> {
  return db.$transaction(async (tx: DbTransactionClient) => {
    await lockTripForCapacity(tx, input.tripId);

    const trip = await tx.trip.findUnique({ where: { id: input.tripId } });
    if (!trip) return fail('NOT_FOUND');
    if (trip.status !== 'PUBLISHED') return fail('TRIP_NOT_PUBLISHED', { status: trip.status });

    // A `@db.Date` column against the organisation's calendar day, not
    // against a raw instant: the deadline is a date somebody wrote down, and
    // in a zone behind UTC the naive comparison turns "today" into "past" for
    // the first hours of every day.
    if (isPastDate(trip.paymentDeadline, new Date(), timeZone)) {
      return fail('PAYMENT_DEADLINE_PASSED');
    }

    const customer = await tx.user.findUnique({
      where: { id: input.customerId },
      include: { customerProfile: { select: { userId: true } } },
    });
    // No `CustomerProfile` means the id belongs to a staff user or to nobody:
    // `Reservation.customerId` points at `customer_profiles.user_id`, so the
    // row could not be written anyway.
    if (!customer?.customerProfile) return fail('NOT_FOUND');
    if (!customer.emailVerifiedAt) return fail('EMAIL_NOT_VERIFIED');

    // Mirrors `reservations_live_trip_customer_key` exactly, expired holds
    // included: a `HELD` row whose expiry has passed no longer occupies a
    // seat, but it is still a live row for that index until the expiry job
    // flips it to `EXPIRED`. Pre-checking a narrower condition than the index
    // enforces would only turn a friendly error into a constraint violation.
    const live = await tx.reservation.findFirst({
      where: { tripId: input.tripId, customerId: input.customerId, status: { in: [...LIVE_STATUSES] } },
      select: { id: true },
    });
    if (live) return fail('DUPLICATE_RESERVATION');

    const committed = await countCommittedSeats(tx, input.tripId);
    const seats = availableSeats({
      totalCapacity: trip.totalCapacity,
      preSoldSeats: trip.preSoldSeats,
      ...committed,
    });
    if (seats < 1) return fail('TRIP_SOLD_OUT');

    // Always set, never conditional: the CHECK constraint
    // `reservations_held_requires_hold_expiry` refuses a `HELD` row without
    // one, and the capacity count reads a `HELD` row with a null expiry as a
    // free seat (see `docs/business-rules/reservations.md`).
    const holdExpiresAt = new Date(Date.now() + trip.holdTtlHours * HOUR_MS);

    const reservation = await tx.reservation.create({
      data: {
        code: await uniqueReservationCode(tx),
        tripId: trip.id,
        customerId: input.customerId,
        status: 'HELD',
        holdExpiresAt,
        // Frozen here: repricing the trip later never moves an existing
        // reservation (schema comment on `Reservation.totalPriceCents`).
        totalPriceCents: trip.pricePerSeatCents,
        minimumDepositCents: trip.minimumDepositCents,
        paymentDeadline: trip.paymentDeadline,
        source: 'APP',
        createdById: input.customerId,
      },
    });

    await recordAudit(tx, {
      actorUserId: input.customerId,
      action: 'reservation.created',
      entityType: 'Reservation',
      entityId: reservation.id,
      after: {
        code: reservation.code,
        tripId: reservation.tripId,
        status: reservation.status,
        holdExpiresAt: holdExpiresAt.toISOString(),
        totalPriceCents: reservation.totalPriceCents,
        minimumDepositCents: reservation.minimumDepositCents,
      },
    });

    return ok(toDto(reservation));
  });
}

/**
 * Creates a reservation in `HELD` for one customer on one trip (§5.2).
 *
 * Retries only a code collision, and only once: a fresh random code is the
 * right answer to two customers drawing the same one, and nobody typed it, so
 * there is nothing for the caller to correct. Every other outcome is final --
 * including a `DUPLICATE_RESERVATION` surfaced by the partial unique index
 * rather than by the pre-check, which is the race the pre-check cannot close
 * on its own.
 */
export async function createReservation(
  db: Db,
  input: CreateReservationInput
): Promise<Result<ReservationDto>> {
  const timeZone = await organizationTimeZone(db);

  for (let attempt = 1; attempt <= CODE_INSERT_ATTEMPTS; attempt++) {
    try {
      return await insertReservation(db, input, timeZone);
    } catch (error) {
      const index = uniqueViolationIndex(error);
      if (index === LIVE_RESERVATION_INDEX) return fail('DUPLICATE_RESERVATION');
      if (index !== RESERVATION_CODE_INDEX) throw error;
    }
  }

  // Colliding twice in a row against a 30^8 space is not bad luck; it is a
  // broken generator or an exhausted table, and retrying forever would only
  // hide it.
  return fail('CONFLICT', { field: 'code' });
}

/**
 * Loads one reservation on behalf of its own customer.
 *
 * A reservation that does not exist and a reservation that belongs to someone
 * else get the **same** answer: same code, same (absent) details, and 404
 * from the HTTP layer. Answering 403, or distinguishing the two codes, would
 * turn this endpoint into an oracle that confirms which ids are real
 * reservations for a customer who is walking them.
 */
export async function getReservationForCustomer(
  db: Db,
  reservationId: string,
  customerId: string
): Promise<Result<ReservationDto>> {
  const reservation = await ownedReservation(db, reservationId, customerId);
  if (!reservation) return fail('RESERVATION_NOT_OWNED');
  return ok(toDto(reservation));
}

/** Every reservation of one customer, newest first. Cancelled and expired ones included: it is their history. */
export async function listReservationsForCustomer(
  db: Db,
  customerId: string
): Promise<Result<ReservationSummaryDto[]>> {
  const reservations = await db.reservation.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
  return ok(reservations.map(toSummaryDto));
}

/**
 * Records that the customer asked for their reservation to be cancelled
 * (§5.6).
 *
 * Deliberately does **not** change the status: the hold keeps running, the
 * seat stays taken and nothing paid moves. A person with `reservation.cancel`
 * decides from the panel; this only puts the request in front of them --
 * which is also why this function notifies them (`CANCELLATION_REQUESTED`,
 * via `notifyAdmins`): without that alert nobody would ever see the request
 * to act on it.
 *
 * Asking twice is a no-op rather than an error -- a customer who does not see
 * an immediate change will press the button again. The first request is the
 * one that stands, reason included, and only it is audited and notified --
 * a second alert for the same request would train staff to ignore the
 * second one on sight, exactly the outcome a real second request needs them
 * not to have.
 */
export async function requestCancellation(
  db: Db,
  reservationId: string,
  customerId: string,
  queue: NotificationQueue,
  reason?: string
): Promise<Result<ReservationDto>> {
  const reservation = await ownedReservation(db, reservationId, customerId);
  if (!reservation) return fail('RESERVATION_NOT_OWNED');
  // There is nothing left to cancel on a terminal reservation, and sealing a
  // request on one would put an alert in front of an administrator who can
  // only dismiss it.
  if (!isLive(reservation.status)) {
    return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
  }

  const updated = await db.$transaction(async (tx: DbTransactionClient) => {
    // The `cancellationRequestedAt: null` filter is what makes the second
    // request a no-op, in one statement rather than in a read followed by a
    // write that another request could interleave with.
    const sealed = await tx.reservation.updateMany({
      where: {
        id: reservationId,
        customerId,
        status: { in: [...LIVE_STATUSES] },
        cancellationRequestedAt: null,
      },
      data: { cancellationRequestedAt: new Date(), cancellationReason: reason ?? null },
    });

    if (sealed.count === 1) {
      await recordAudit(tx, {
        actorUserId: customerId,
        action: 'reservation.cancellation_requested',
        entityType: 'Reservation',
        entityId: reservationId,
        after: { reason: reason ?? null },
      });

      // `@rm/domain-payments`' webhook handler already depends on
      // `@rm/domain-notifications` for this exact shape of staff-only
      // alert (ORPHAN_PAYMENT, PAID_CENTS_MISMATCH); this is the same kind
      // of edge, not a new one -- `@rm/domain-reservations` does not import
      // `@rm/domain-payments` or vice versa, which is the dependency this
      // module's own architecture note (`docs/business-rules/
      // reservations.md`) actually forbids.
      const customer = await tx.customerProfile.findUniqueOrThrow({
        where: { userId: customerId },
        select: { fullName: true },
      });
      await notifyAdmins(tx, queue, {
        reservationId,
        eventType: 'CANCELLATION_REQUESTED',
        params: {
          reservationCode: reservation.code,
          customerName: customer.fullName,
          reason: reason ?? '',
        },
      });
    }

    return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  });

  return ok(toDto(updated));
}

function isLive(status: ReservationStatus): boolean {
  return (LIVE_STATUSES as readonly ReservationStatus[]).includes(status);
}

/**
 * The reservation with that id, but only if this customer owns it. Returns
 * `undefined` for both "no such reservation" and "not yours" so every caller
 * answers the two identically -- see `getReservationForCustomer`.
 */
async function ownedReservation(
  db: Db,
  reservationId: string,
  customerId: string
): Promise<Reservation | undefined> {
  const reservation = await db.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation || reservation.customerId !== customerId) return undefined;
  return reservation;
}
