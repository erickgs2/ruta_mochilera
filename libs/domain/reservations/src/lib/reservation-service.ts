import {
  uniqueViolationIndex,
  type Db,
  type DbTransactionClient,
  type Reservation,
  type ReservationStatus,
} from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { notifyAdmins, notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';
import { organizationTimeZone } from '@rm/domain-settings';
import { fail, isPastDate, ok, type Result } from '@rm/shared-utils';
import { availableSeats, countCommittedSeats, lockTripForCapacity } from './capacity';
import { generateReservationCode } from './reservation-code';

export interface CreateReservationInput {
  tripId: string;
  customerId: string;
}

/**
 * Records the first payment of a reservation taken at the counter, **inside
 * the reservation's own transaction** (Phase 2B, §5.2): the reservation and
 * its money are one fact. Implemented by `@rm/domain-payments`'
 * `createInitialCashPayment` and typed here structurally, for the same
 * reason as `CancelPendingPaymentIntents`. A failed `Result` rolls the
 * reservation back.
 */
export type RecordInitialPayment = (
  tx: DbTransactionClient,
  input: { reservationId: string; amountCents: number; actorId: string }
) => Promise<Result<unknown>>;

export interface CreateBranchReservationInput {
  tripId: string;
  customerId: string;
  /** The staff member at the counter: `created_by` and the audit actor. */
  actorId: string;
  /** Cash taken together with the reservation. Omitted: the reservation is only held. */
  initialPayment?: { amountCents: number; record: RecordInitialPayment };
}

/** Where a reservation is being created from, and by whom. */
interface CreationContext {
  source: 'APP' | 'BRANCH';
  actorId: string;
  initialPayment?: CreateBranchReservationInput['initialPayment'];
}

/** Carries a failed `Result` out of a transaction so the transaction rolls back. */
class RollbackWith extends Error {
  constructor(readonly result: Result<never>) {
    super('rolled back');
  }
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
  /** Derived, never stored: `total_price_cents - paid_cents`, floored at zero. */
  balanceCents: number;
  paymentDeadline: Date;
  cancellationRequestedAt: Date | null;
  createdAt: Date;
}

/**
 * What a list row needs. Drops the detail-only fields (`minimumDepositCents`,
 * `cancellationRequestedAt`) and carries just enough of the
 * trip to name the row (Task 18, "Mis reservas"): the client cannot resolve
 * a `tripId` on its own -- the public list is keyed by slug and only shows
 * published trips, while a customer's history includes trips that have since
 * finished or been cancelled.
 */
export interface ReservationSummaryDto {
  id: string;
  code: string;
  tripId: string;
  /** The Spanish translation's name, else the slug -- the same rule as the public catalogue's summary. */
  tripName: string;
  /** A calendar date (`@db.Date`): render it as that day, never shifted by the viewer's zone. */
  tripDepartureDate: Date;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  totalPriceCents: number;
  paidCents: number;
  balanceCents: number;
  paymentDeadline: Date;
  createdAt: Date;
}

/** What staff can narrow the panel's reservation list by (Task 19). Every field is optional and they combine with AND. */
export interface StaffReservationFilter {
  tripId?: string;
  status?: ReservationStatus;
  /** `true` keeps only the unresolved cancellation requests -- see `cancellationPending`. */
  cancellationPending?: boolean;
}

/**
 * A row of the panel's reservation list: the customer's summary plus who the
 * customer is and where their cancellation request stands. Staff read many
 * customers' reservations at once, so the row names the customer; the
 * customer's own list never needs to.
 */
export interface StaffReservationSummaryDto {
  id: string;
  code: string;
  tripId: string;
  /** Same rule as `ReservationSummaryDto.tripName`: the Spanish name, else the slug. */
  tripName: string;
  tripDepartureDate: Date;
  customerId: string;
  customerName: string;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  totalPriceCents: number;
  paidCents: number;
  balanceCents: number;
  paymentDeadline: Date;
  cancellationRequestedAt: Date | null;
  /**
   * Derived, never stored: the customer asked to cancel and the reservation
   * is still `HELD` or `ACTIVE`, so a person has a decision to make. A
   * request on a reservation that has since been cancelled or has expired is
   * history, not work.
   */
  cancellationPending: boolean;
  createdAt: Date;
}

/** One reservation as the panel's detail screen reads it. Payments come from `@rm/domain-payments`, never from here. */
export interface StaffReservationDetailDto extends ReservationDto {
  tripName: string;
  tripDepartureDate: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** What the customer wrote when asking to cancel. Never overwritten by staff: their reason lives in the audit log. */
  cancellationReason: string | null;
  cancellationPending: boolean;
  cancelledAt: Date | null;
  /** The staff member's full name, or `null` while the reservation is not cancelled. */
  cancelledByName: string | null;
  /** When staff declined the pending request, or `null`. A new request from the customer clears it. */
  cancellationDeclinedAt: Date | null;
  cancellationDeclinedByName: string | null;
  /** What staff told the customer when declining. */
  cancellationDeclineReason: string | null;
}

export interface DeclineCancellationRequestInput {
  reservationId: string;
  actorId: string;
  /** Why the request does not go ahead. Goes to the customer's notice and to the audit entry. */
  reason: string;
}

export interface CancelReservationInput {
  reservationId: string;
  /** The staff member deciding. Recorded on the row (`cancelled_by`) and in the audit entry. */
  actorId: string;
  /** Why staff cancelled. Goes to the customer's notice and to the audit entry. */
  reason: string;
}

/**
 * Cancels the provider-side payment intents still pending on one
 * reservation, after the caller's transaction has committed. The same shape `expireHolds`
 * (`apps/worker`) takes, and implemented once, by `@rm/domain-payments`'
 * `createCancelPendingPaymentIntents` -- typed here structurally so this
 * library never imports the payments domain (see
 * `docs/business-rules/reservations.md`).
 */
export type CancelPendingPaymentIntents = (client: Db | DbTransactionClient, reservationId: string) => Promise<void>;

/**
 * Turns what a cancelled reservation had received into the customer's credit
 * (Phase 2B, business rule 5.5), **inside** the cancellation's transaction:
 * the reservation turning CANCELLED and its money becoming available are one
 * fact, never two. Implemented by `@rm/domain-payments`'
 * `creditFromCancellation` and typed here structurally, for the same reason
 * as `CancelPendingPaymentIntents`.
 */
export type CreditFromCancellation = (
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; amountCents: number; actorId?: string }
) => Promise<void>;

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
    balanceCents: balanceOf(reservation),
    paymentDeadline: reservation.paymentDeadline,
    cancellationRequestedAt: reservation.cancellationRequestedAt,
    createdAt: reservation.createdAt,
  };
}

/** What `listReservationsForCustomer` loads of each row's trip. */
const SUMMARY_TRIP_SELECT = {
  slug: true,
  departureDate: true,
  translations: { where: { locale: 'es' as const }, select: { name: true } },
};

type ReservationWithSummaryTrip = Reservation & {
  trip: { slug: string; departureDate: Date; translations: { name: string }[] };
};

function toSummaryDto(reservation: ReservationWithSummaryTrip): ReservationSummaryDto {
  return {
    id: reservation.id,
    code: reservation.code,
    tripId: reservation.tripId,
    tripName: reservation.trip.translations[0]?.name ?? reservation.trip.slug,
    tripDepartureDate: reservation.trip.departureDate,
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
  timeZone: string,
  context: CreationContext
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
        source: context.source,
        createdById: context.actorId,
      },
    });

    await recordAudit(tx, {
      actorUserId: context.actorId,
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
        source: context.source,
      },
    });

    if (!context.initialPayment) return ok(toDto(reservation));

    // The payment moves `paid_cents` and, when it covers the deposit, turns
    // the row ACTIVE and clears the hold -- so the answer is read back after.
    const paid = await context.initialPayment.record(tx, {
      reservationId: reservation.id,
      amountCents: context.initialPayment.amountCents,
      actorId: context.actorId,
    });
    if (!paid.ok) throw new RollbackWith(paid);
    return ok(toDto(await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } })));
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
  return createWithRetry(db, input, { source: 'APP', actorId: input.customerId });
}

/**
 * A reservation taken at the counter (Phase 2B, §5.2): the same rules as the
 * app's -- trip row locked, published, payment deadline not passed, one live
 * reservation per customer and trip, a free seat, amounts frozen -- with
 * `source = BRANCH` and `created_by` = the staff member.
 *
 * With `initialPayment`, the first cash payment is recorded by the injected
 * hook **in the same transaction**: a payment that covers the deposit makes
 * the reservation ACTIVE with no hold; a smaller one leaves it HELD with the
 * trip's normal hold. Anything that fails -- seat, deadline, the payment
 * itself -- leaves neither a reservation nor a payment.
 */
export async function createBranchReservation(
  db: Db,
  input: CreateBranchReservationInput
): Promise<Result<ReservationDto>> {
  if (input.initialPayment && (!Number.isInteger(input.initialPayment.amountCents) || input.initialPayment.amountCents <= 0)) {
    return fail('VALIDATION_FAILED', { field: 'initialPaymentCents' });
  }
  return createWithRetry(
    db,
    { tripId: input.tripId, customerId: input.customerId },
    { source: 'BRANCH', actorId: input.actorId, initialPayment: input.initialPayment }
  );
}

async function createWithRetry(
  db: Db,
  input: CreateReservationInput,
  context: CreationContext
): Promise<Result<ReservationDto>> {
  const timeZone = await organizationTimeZone(db);

  for (let attempt = 1; attempt <= CODE_INSERT_ATTEMPTS; attempt++) {
    try {
      return await insertReservation(db, input, timeZone, context);
    } catch (error) {
      if (error instanceof RollbackWith) return error.result;
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
    include: { trip: { select: SUMMARY_TRIP_SELECT } },
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
    // A request staff already declined is closed, so asking again opens a
    // new one (and clears the decline); a request still pending is left
    // alone, which is what makes asking twice a no-op.
    const sealed = await tx.reservation.updateMany({
      where: {
        id: reservationId,
        customerId,
        status: { in: [...LIVE_STATUSES] },
        OR: [{ cancellationRequestedAt: null }, { cancellationDeclinedAt: { not: null } }],
      },
      data: {
        cancellationRequestedAt: new Date(),
        cancellationReason: reason ?? null,
        cancellationDeclinedAt: null,
        cancellationDeclinedById: null,
        cancellationDeclineReason: null,
      },
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

/** What the staff list and detail load of each reservation's trip and customer. */
const STAFF_INCLUDE = {
  trip: { select: SUMMARY_TRIP_SELECT },
  customer: { select: { fullName: true, phone: true, user: { select: { email: true } } } },
  cancelledBy: { select: { staffProfile: { select: { fullName: true } } } },
  cancellationDeclinedBy: { select: { staffProfile: { select: { fullName: true } } } },
};

type ReservationForStaff = Reservation & {
  trip: { slug: string; departureDate: Date; translations: { name: string }[] };
  customer: { fullName: string; phone: string; user: { email: string } };
  cancelledBy: { staffProfile: { fullName: string } | null } | null;
  cancellationDeclinedBy: { staffProfile: { fullName: string } | null } | null;
};

function isCancellationPending(reservation: Reservation): boolean {
  return (
    reservation.cancellationRequestedAt !== null &&
    reservation.cancellationDeclinedAt === null &&
    isLive(reservation.status)
  );
}

function toStaffSummaryDto(reservation: ReservationForStaff): StaffReservationSummaryDto {
  return {
    id: reservation.id,
    code: reservation.code,
    tripId: reservation.tripId,
    tripName: reservation.trip.translations[0]?.name ?? reservation.trip.slug,
    tripDepartureDate: reservation.trip.departureDate,
    customerId: reservation.customerId,
    customerName: reservation.customer.fullName,
    status: reservation.status,
    holdExpiresAt: reservation.holdExpiresAt,
    totalPriceCents: reservation.totalPriceCents,
    paidCents: reservation.paidCents,
    balanceCents: balanceOf(reservation),
    paymentDeadline: reservation.paymentDeadline,
    cancellationRequestedAt: reservation.cancellationRequestedAt,
    cancellationPending: isCancellationPending(reservation),
    createdAt: reservation.createdAt,
  };
}

function toStaffDetailDto(reservation: ReservationForStaff): StaffReservationDetailDto {
  return {
    ...toDto(reservation),
    tripName: reservation.trip.translations[0]?.name ?? reservation.trip.slug,
    tripDepartureDate: reservation.trip.departureDate,
    customerName: reservation.customer.fullName,
    customerEmail: reservation.customer.user.email,
    customerPhone: reservation.customer.phone,
    cancellationReason: reservation.cancellationReason,
    cancellationPending: isCancellationPending(reservation),
    cancelledAt: reservation.cancelledAt,
    cancelledByName: reservation.cancelledBy?.staffProfile?.fullName ?? null,
    cancellationDeclinedAt: reservation.cancellationDeclinedAt,
    cancellationDeclinedByName: reservation.cancellationDeclinedBy?.staffProfile?.fullName ?? null,
    cancellationDeclineReason: reservation.cancellationDeclineReason,
  };
}

/**
 * The panel's reservation list (Task 19): every customer's reservations,
 * narrowed by `filter`, ordered as the administrator's work queue.
 *
 * **Unresolved cancellation requests come first**, oldest request first --
 * they are the only rows that wait on a person, and first come, first
 * served. Everything else follows newest first, like the customer's own
 * list. The order is decided here, not in the screen, so every client of
 * this endpoint sees the same queue.
 *
 * Not paginated, like `listTrips`: one agency's reservations fit in one
 * response for the foreseeable future, and a cursor would complicate the
 * "pending first" order for no present benefit.
 */
export async function listReservationsForStaff(
  db: Db,
  filter: StaffReservationFilter
): Promise<Result<StaffReservationSummaryDto[]>> {
  const reservations = await db.reservation.findMany({
    where: {
      tripId: filter.tripId,
      status: filter.status,
      ...(filter.cancellationPending === undefined
        ? {}
        : filter.cancellationPending
          ? {
              cancellationRequestedAt: { not: null },
              cancellationDeclinedAt: null,
              status: filterLiveStatus(filter.status),
            }
          : {
              OR: [
                { cancellationRequestedAt: null },
                { cancellationDeclinedAt: { not: null } },
                { status: { notIn: [...LIVE_STATUSES] } },
              ],
            }),
    },
    include: STAFF_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  const rows = reservations.map(toStaffSummaryDto);
  const pending = rows
    .filter((row) => row.cancellationPending)
    .sort((a, b) => (a.cancellationRequestedAt?.getTime() ?? 0) - (b.cancellationRequestedAt?.getTime() ?? 0));
  const rest = rows.filter((row) => !row.cancellationPending);
  return ok([...pending, ...rest]);
}

/**
 * The status condition for "pending only": the live statuses, intersected
 * with the caller's own `status` filter when there is one -- so asking for
 * pending `CANCELLED` rows correctly answers nothing instead of ignoring
 * one of the two filters.
 */
function filterLiveStatus(status: ReservationStatus | undefined) {
  if (status === undefined) return { in: [...LIVE_STATUSES] };
  return isLive(status) ? status : { in: [] };
}

/**
 * Any reservation, for staff. Unlike `getReservationForCustomer` there is no
 * ownership to hide behind, so an unknown id is a plain `NOT_FOUND`: the
 * route is already gated on `reservation.view`, and staff are allowed to
 * know which reservations exist.
 */
export async function getReservationForStaff(
  db: Db,
  reservationId: string
): Promise<Result<StaffReservationDetailDto>> {
  const reservation = await db.reservation.findUnique({ where: { id: reservationId }, include: STAFF_INCLUDE });
  if (!reservation) return fail('NOT_FOUND');
  return ok(toStaffDetailDto(reservation));
}

/**
 * A person with `reservation.cancel` cancels a reservation (§5.6, Task 19).
 *
 * **Releasing the seat is not a write of its own.** Available seats are
 * derived (§5.1): once the row is `CANCELLED`, `countCommittedSeats` stops
 * counting it. Nothing here touches the trip.
 *
 * **Money stays exactly where it is.** `paid_cents` and every `Payment` row
 * are left untouched: erasing them would destroy the accounting record.
 * What changes is that the money becomes the customer's credit: when the
 * caller provides `creditFromCancellation`, it runs in this same transaction,
 * once, with the `paid_cents` read after the row was locked by the
 * conditional update -- so a payment confirmed a moment earlier is counted
 * and one confirmed a moment later lands on a CANCELLED row (the webhook
 * credits that one itself).
 *
 * **Idempotent.** Cancelling an already `CANCELLED` reservation answers it as
 * it is, with no second notice, audit entry or intent cancellation. The
 * write is a conditional `updateMany` on the live statuses, so two people
 * pressing the button at once -- or a payment activating the reservation in
 * between -- resolve in the database, not in a read followed by a write:
 * exactly one of them flips the row and does the rest.
 *
 * **An `EXPIRED` reservation is refused** (`INVALID_STATUS_TRANSITION`): its
 * seat is already free and its hold is over, so there is nothing for a
 * person to decide, and relabelling it would rewrite what happened.
 *
 * Pending payment intents are cancelled through `cancelPendingPaymentIntents`
 * when the caller provides it, after the transaction commits and only on the
 * call that actually cancelled: an OXXO voucher left payable for a cancelled
 * reservation is money that arrives for a seat that no longer exists.
 */
export async function cancelReservation(
  db: Db,
  queue: NotificationQueue,
  input: CancelReservationInput,
  cancelPendingPaymentIntents?: CancelPendingPaymentIntents,
  creditFromCancellation?: CreditFromCancellation
): Promise<Result<StaffReservationDetailDto>> {
  const outcome = await db.$transaction(async (tx: DbTransactionClient): Promise<Result<boolean>> => {
    const reservation = await tx.reservation.findUnique({
      where: { id: input.reservationId },
      include: {
        customer: { select: { user: { select: { locale: true } } } },
        trip: { select: { slug: true, translations: { select: { locale: true, name: true } } } },
      },
    });
    if (!reservation) return fail('NOT_FOUND');

    const cancelled = await tx.reservation.updateMany({
      where: { id: input.reservationId, status: { in: [...LIVE_STATUSES] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: input.actorId },
    });

    if (cancelled.count === 0) {
      // Re-read rather than trust the first read: a concurrent cancellation
      // may have committed between the two statements.
      const current = await tx.reservation.findUniqueOrThrow({
        where: { id: input.reservationId },
        select: { status: true },
      });
      if (current.status === 'CANCELLED') return ok(false);
      return fail('INVALID_STATUS_TRANSITION', { status: current.status });
    }

    // Re-read under the lock the update above now holds: `paid_cents` may
    // have moved since the first read, and the credit must be what the
    // reservation really received.
    const { paidCents } = await tx.reservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      select: { paidCents: true },
    });

    await recordAudit(tx, {
      actorUserId: input.actorId,
      action: 'reservation.cancelled',
      entityType: 'Reservation',
      entityId: reservation.id,
      before: { status: reservation.status, paidCents },
      after: { status: 'CANCELLED', reason: input.reason, paidCents },
    });

    if (creditFromCancellation && paidCents > 0) {
      await creditFromCancellation(tx, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        amountCents: paidCents,
        actorId: input.actorId,
      });
    }

    const locale = reservation.customer.user.locale;
    await notifyCustomer(tx, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      eventType: 'RESERVATION_CANCELLED',
      params: { tripName: tripNameFor(reservation.trip, locale), reason: input.reason },
    });

    return ok(true);
  });

  if (!outcome.ok) return outcome;
  // After the commit, only on the call that actually cancelled -- see
  // `expireHolds` (apps/worker) for why a provider call never runs inside
  // the transaction.
  if (outcome.value && cancelPendingPaymentIntents) {
    await cancelPendingPaymentIntents(db, input.reservationId);
  }
  return getReservationForStaff(db, input.reservationId);
}

/**
 * Staff decide a cancellation request does not go ahead (§5.6): the
 * reservation stays exactly as it is -- status, hold, seat and money -- and
 * the request leaves the pending queue. The customer is told why
 * (`CANCELLATION_DECLINED`) and can ask again, which reopens it (see
 * `requestCancellation`).
 *
 * The customer's own reason is never overwritten: staff's goes to its own
 * column, the notice and the audit entry.
 *
 * **Idempotent**, by the same conditional-write idiom as `cancelReservation`:
 * declining an already declined request answers it as it is, with no second
 * notice or audit entry, and keeps the first decision. A reservation with no
 * request is `NO_CANCELLATION_REQUEST`; one already `CANCELLED` or `EXPIRED`
 * is `INVALID_STATUS_TRANSITION` -- there is nothing left to decide on.
 */
export async function declineCancellationRequest(
  db: Db,
  queue: NotificationQueue,
  input: DeclineCancellationRequestInput
): Promise<Result<StaffReservationDetailDto>> {
  const outcome = await db.$transaction(async (tx: DbTransactionClient): Promise<Result<null>> => {
    const reservation = await tx.reservation.findUnique({
      where: { id: input.reservationId },
      include: {
        customer: { select: { user: { select: { locale: true } } } },
        trip: { select: { slug: true, translations: { select: { locale: true, name: true } } } },
      },
    });
    if (!reservation) return fail('NOT_FOUND');

    const declined = await tx.reservation.updateMany({
      where: {
        id: input.reservationId,
        status: { in: [...LIVE_STATUSES] },
        cancellationRequestedAt: { not: null },
        cancellationDeclinedAt: null,
      },
      data: {
        cancellationDeclinedAt: new Date(),
        cancellationDeclinedById: input.actorId,
        cancellationDeclineReason: input.reason,
      },
    });

    if (declined.count === 0) {
      // Re-read: another decline, a cancellation or an expiry may have
      // committed since the first read.
      const current = await tx.reservation.findUniqueOrThrow({
        where: { id: input.reservationId },
        select: { status: true, cancellationRequestedAt: true, cancellationDeclinedAt: true },
      });
      if (!isLive(current.status)) return fail('INVALID_STATUS_TRANSITION', { status: current.status });
      if (current.cancellationRequestedAt === null) return fail('NO_CANCELLATION_REQUEST');
      return ok(null); // already declined
    }

    await recordAudit(tx, {
      actorUserId: input.actorId,
      action: 'reservation.cancellation_declined',
      entityType: 'Reservation',
      entityId: reservation.id,
      before: { cancellationReason: reservation.cancellationReason },
      after: { reason: input.reason },
    });

    await notifyCustomer(tx, queue, {
      customerId: reservation.customerId,
      reservationId: reservation.id,
      eventType: 'CANCELLATION_DECLINED',
      params: { tripName: tripNameFor(reservation.trip, reservation.customer.user.locale), reason: input.reason },
    });

    return ok(null);
  });

  if (!outcome.ok) return outcome;
  return getReservationForStaff(db, input.reservationId);
}

/** The trip's name in the recipient's locale, else any translation, else the slug -- as `expireHolds` names it. */
function tripNameFor(trip: { slug: string; translations: { locale: string; name: string }[] }, locale: string): string {
  const translation = trip.translations.find((candidate) => candidate.locale === locale) ?? trip.translations[0];
  return translation?.name ?? trip.slug;
}
