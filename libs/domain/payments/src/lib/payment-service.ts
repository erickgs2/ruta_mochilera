import {
  uniqueViolationIndex,
  type Db,
  type DbTransactionClient,
  type Payment,
  type PaymentMethod,
  type PaymentProvider,
  type PaymentStatus,
  type Reservation,
} from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { organizationTimeZone } from '@rm/domain-settings';
import { endOfCalendarDay, fail, monthStartsBetween, ok, type Result } from '@rm/shared-utils';
import { suggestedMonthly } from './instalment';
import { assignReceiptNumber } from './receipt-number';

export interface RecordPaymentInput {
  reservationId: string;
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: PaymentProvider;
  providerIntentId?: string;
  /**
   * When the money actually moved, as opposed to when this row was written.
   * Defaults to now for a payment recorded as `SUCCEEDED`. Phase 2B's
   * historical capture passes the real date so a March payment keeps
   * appearing in March.
   */
  paidAt?: Date;
  /**
   * OXXO only, both added for Task 14's `createPaymentIntentForReservation`:
   * the first caller that creates a `PENDING` row at the same moment it
   * asks the provider for a voucher, rather than only ever moving a row
   * `confirmPaymentWithin`'s `recordIfMissing` branch has to invent after
   * the fact. Every other caller omits them and the columns stay null, same
   * as before this field existed.
   */
  providerVoucherUrl?: string;
  voucherExpiresAt?: Date;
  /** The staff member who took the money (counter, credit, backfill). */
  recordedById?: string;
  notes?: string;
  /** Historical capture (Phase 2B): the payment happened before the system. */
  isBackfilled?: boolean;
  /** The agency's own reference from a CSV import; unique when present. */
  externalRef?: string;
}

export interface ConfirmPaymentInput {
  providerIntentId: string;
  paidAt: Date;
  /**
   * What to write when **no payment row exists for this intent yet** --
   * the Task 5 review's first inherited finding.
   *
   * The old signature carried an intent id and a timestamp and nothing
   * else, so it could only ever move a row that was already there; a
   * `payment_intent.succeeded` for an intent whose `PENDING` row was never
   * committed came back `NOT_FOUND` and the money was never recorded
   * anywhere. That is the worst outcome available to a payment system:
   * Stripe says it took the money and we have no row for it.
   *
   * The webhook fills this in from the intent's own metadata, so the
   * normal path (confirm the row we already have) is unchanged and the
   * missing-row path records the money instead of dropping it. Omit it and
   * an unknown intent is still `NOT_FOUND` -- a caller with nothing to
   * record it against (no reservation, no amount) genuinely cannot write
   * the row, and must escalate instead.
   */
  recordIfMissing?: {
    reservationId: string;
    amountCents: number;
    method: PaymentMethod;
    provider: PaymentProvider;
  };
}

/**
 * What a payment looks like outside the domain.
 *
 * Carries the voucher fields because the customer app needs them to show an
 * OXXO slip and its deadline, and leaves out everything that is nobody's
 * business outside the backend: `providerIntentId`, `recordedById`,
 * `isBackfilled`, `notes` and the storage key of the receipt PDF. A caller
 * that confirms a payment already knows the intent id -- it passed it in.
 * `receiptNumber` is null until the payment is SUCCEEDED.
 */
export interface PaymentDto {
  id: string;
  reservationId: string;
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: PaymentProvider;
  paidAt: Date | null;
  recordedAt: Date;
  providerVoucherUrl: string | null;
  voucherExpiresAt: Date | null;
  receiptNumber: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `total_price_cents - paid_cents`, never negative (business rule 5.5). */
function balanceOf(reservation: Reservation): number {
  return Math.max(0, reservation.totalPriceCents - reservation.paidCents);
}

function toDto(payment: Payment): PaymentDto {
  return {
    id: payment.id,
    reservationId: payment.reservationId,
    amountCents: payment.amountCents,
    method: payment.method,
    status: payment.status,
    provider: payment.provider,
    paidAt: payment.paidAt,
    recordedAt: payment.recordedAt,
    providerVoucherUrl: payment.providerVoucherUrl,
    voucherExpiresAt: payment.voucherExpiresAt,
    receiptNumber: payment.receiptNumber,
  };
}

/**
 * Locks the reservation's row for the rest of the caller's transaction, so
 * that the read-decide-write sequence recording a payment performs cannot
 * interleave with another one for the same reservation.
 *
 * The balance is derived from `paid_cents`, so two concurrent payments would
 * both read the same balance, both find room for the full amount and both
 * insert -- a reservation paid twice over. Under READ COMMITTED the second
 * transaction blocks here until the first commits, and the balance it then
 * reads already includes the first payment.
 *
 * Must be called inside a transaction: a row lock taken outside one is
 * released the moment the statement ends. The id is bound as a query
 * parameter by the tagged template, never concatenated into the SQL.
 */
async function lockReservationForPayment(
  tx: DbTransactionClient,
  reservationId: string
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
}

/**
 * Applies money that has actually arrived to the reservation it belongs to.
 *
 * Two writes, both inside the caller's transaction:
 *
 * 1. `paid_cents` grows by the amount. The increment is done by the database
 *    rather than by reading and writing back, so it is correct even if the
 *    row lock above were ever dropped.
 * 2. A `HELD` reservation whose accumulated payments now cover the minimum
 *    deposit becomes `ACTIVE`, and its `hold_expires_at` is cleared **in the
 *    same statement**. The two belong together: the CHECK constraint
 *    `reservations_held_requires_hold_expiry` only ties HELD to a non-null
 *    expiry, so an ACTIVE row keeping one is a state the database accepts and
 *    the domain considers nonsense -- a seat that is taken and still counting
 *    down.
 *
 * Any other status is left exactly as it is. In particular an `EXPIRED`
 * reservation is **not** revived by a late OXXO confirmation (business rule
 * 5.3): the money exists and must be visible, but giving the seat back is a
 * human decision. `paid_cents` still moves, because the nightly
 * reconciliation compares it against the `SUCCEEDED` payment rows and a
 * payment recorded without it would be permanent, false drift.
 *
 * **Task 8 hardening.** The second write used to be a plain `update` keyed
 * only on `id`. That was never exploitable in practice -- the first write
 * above already re-reads the row under the lock this function's caller took
 * (or this function's own first write takes), and the `if` that guards this
 * write already refuses to fire once that fresh read shows anything but
 * `HELD` -- so no sequence of events was ever found, concurrent or not, that
 * made the old unconditional write visibly wrong (see the "does not
 * resurrect..." test in `payment-service.spec.ts`, which passes against the
 * old code too). It is written as a conditional `updateMany` anyway, now that
 * `expireHolds` (apps/worker) is the first other writer ever to contend for
 * this exact row: this makes the write correct *by its own WHERE clause*,
 * the same idiom `confirmPayment`'s own PENDING -> SUCCEEDED transition
 * already uses, rather than correct only as a consequence of how long some
 * other function happens to hold a lock.
 */
async function applyConfirmedPayment(
  tx: DbTransactionClient,
  reservationId: string,
  amountCents: number
): Promise<Reservation> {
  const reservation = await tx.reservation.update({
    where: { id: reservationId },
    data: { paidCents: { increment: amountCents } },
  });

  if (reservation.status === 'HELD' && reservation.paidCents >= reservation.minimumDepositCents) {
    await tx.reservation.updateMany({
      where: { id: reservationId, status: 'HELD' },
      data: { status: 'ACTIVE', holdExpiresAt: null },
    });
  }
  return reservation;
}

/**
 * Records one payment against a reservation (business rule 5.5).
 *
 * Takes a `DbTransactionClient` and never opens a transaction of its own,
 * because it always runs inside the caller's: the Stripe webhook writes the
 * `StripeEvent` row that makes it idempotent in the same transaction, and
 * Phase 2B's counter sale writes the receipt in it too. The denormalised
 * `paid_cents` moves here or nowhere.
 *
 * The amount is checked against the balance, and **pending payments do not
 * count towards it**: an OXXO voucher reserves nothing until the money
 * arrives, which is why the app shows it as pending and warns that the seat
 * can be released. Two outstanding vouchers can therefore both be issued for
 * the full balance and both be confirmed; that overpayment becomes credit in
 * Phase 2B, and recording it is still right -- money that moved must be
 * visible.
 *
 * The status of the reservation is not checked. A payment for a `CANCELLED`
 * or `EXPIRED` reservation is recorded like any other (rule 5.3); what it
 * does *not* do is change that reservation's status.
 */
export async function recordPayment(
  tx: DbTransactionClient,
  input: RecordPaymentInput
): Promise<Result<PaymentDto>> {
  // Money is `Int` in cents, so a fractional amount is a caller bug, not a
  // rounding question to resolve here.
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }

  // Checked before the balance, and before the lock: a redelivered intent is
  // a duplicate whatever the balance now says. The other order answers
  // PAYMENT_EXCEEDS_BALANCE to the second delivery of a payment that already
  // settled the reservation, which reads as "this payment is wrong" when the
  // truth is "this payment is already here".
  //
  // Normal path for the "one intent, one payment" rule; the unique index
  // `payments_provider_intent_id_key` is the net. The pre-check exists
  // because a unique violation aborts the caller's whole transaction, which
  // is the wrong answer to a webhook Stripe simply delivered twice -- but it
  // cannot see a row another transaction has not committed yet, so the index
  // has to stay.
  if (input.providerIntentId) {
    const existing = await tx.payment.findUnique({
      where: { providerIntentId: input.providerIntentId },
      select: { id: true },
    });
    if (existing) return fail('CONFLICT', { field: 'providerIntentId' });
  }

  // Checked before the `::uuid` cast in the lock: an id that is not a UUID
  // (an intent created outside the app can carry any metadata) would make
  // PostgreSQL raise, aborting the caller's whole transaction instead of
  // answering the NOT_FOUND the webhook escalates to a person.
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');

  await lockReservationForPayment(tx, input.reservationId);
  const reservation = await tx.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) return fail('NOT_FOUND');

  const balanceCents = balanceOf(reservation);
  if (input.amountCents > balanceCents) {
    return fail('PAYMENT_EXCEEDS_BALANCE', { amountCents: input.amountCents, balanceCents });
  }

  // Money already in hand always carries the moment it arrived; anything
  // else has not been paid yet and must not pretend otherwise.
  const paidAt = input.paidAt ?? (input.status === 'SUCCEEDED' ? new Date() : null);

  let payment: Payment;
  try {
    payment = await tx.payment.create({
      data: {
        reservationId: reservation.id,
        amountCents: input.amountCents,
        method: input.method,
        status: input.status,
        provider: input.provider,
        providerIntentId: input.providerIntentId ?? null,
        paidAt,
        // Only money that arrived gets a receipt number, and it gets it in
        // this transaction (see `assignReceiptNumber`). Taken last among the
        // checks above, so no early return can leave a number unused.
        receiptNumber:
          input.status === 'SUCCEEDED' && paidAt ? await assignReceiptNumber(tx, paidAt) : null,
        // The balance this payment leaves behind, read under the lock above.
        ...(input.status === 'SUCCEEDED'
          ? {
              receiptTotalCents: reservation.totalPriceCents,
              receiptPaidCents: reservation.paidCents + input.amountCents,
            }
          : {}),
        providerVoucherUrl: input.providerVoucherUrl ?? null,
        voucherExpiresAt: input.voucherExpiresAt ?? null,
        recordedById: input.recordedById ?? null,
        notes: input.notes ?? '',
        isBackfilled: input.isBackfilled ?? false,
        externalRef: input.externalRef ?? null,
      },
    });
  } catch (error) {
    // The Task 5 review's second inherited finding. The pre-check above is
    // the normal path, but it cannot see a row another transaction has not
    // committed yet, so two deliveries in flight at once both pass it and
    // the loser lands on `payments_provider_intent_id_key`. That used to
    // escape as a raw `P2002`; inside the Stripe webhook a thrown exception
    // is a 500, and Stripe retries a 500 forever.
    //
    // **The caller's transaction is already aborted when this returns.**
    // PostgreSQL aborts a transaction on a constraint violation and nothing
    // in Prisma's interactive-transaction API can undo that, so this
    // converts the throw into the `Result` the caller can reason about and
    // the caller must then roll back rather than commit more work on top.
    // `handleStripeEvent` does exactly that: any failed `Result` rolls its
    // transaction back, leaving the `StripeEvent` row unwritten so Stripe's
    // next delivery of the same event gets a clean run.
    if (uniqueViolationIndex(error) === 'payments_provider_intent_id_key') {
      return fail('CONFLICT', { field: 'providerIntentId' });
    }
    // Same reasoning for an imported payment's reference: the caller's
    // transaction is aborted and must roll back.
    if (uniqueViolationIndex(error) === 'payments_external_ref_key') {
      return fail('CONFLICT', { field: 'externalRef' });
    }
    throw error;
  }

  if (payment.status === 'SUCCEEDED') {
    await applyConfirmedPayment(tx, reservation.id, payment.amountCents);
  }

  await recordAudit(tx, {
    actorUserId: input.recordedById,
    action: 'payment.recorded',
    entityType: 'Payment',
    entityId: payment.id,
    after: {
      reservationId: payment.reservationId,
      amountCents: payment.amountCents,
      method: payment.method,
      status: payment.status,
      provider: payment.provider,
    },
  });

  return ok(toDto(payment));
}

/**
 * Confirms a payment the provider has told us succeeded, and applies it
 * (business rule 5.5).
 *
 * Opens a transaction of its own for callers that have none --
 * a reconciliation tool, a counter screen. The Stripe webhook uses
 * `confirmPaymentWithin` instead, because its own `StripeEvent` row has to
 * share the transaction. Either way the money is applied by the same
 * `applyConfirmedPayment` that `recordPayment` uses, so a payment confirmed
 * later and a payment recorded as already succeeded move the balance
 * through one piece of code.
 *
 * **An intent with no local row.** See `ConfirmPaymentInput.recordIfMissing`:
 * with it, the payment is recorded instead of being dropped; without it,
 * an unknown intent is still `NOT_FOUND`.
 *
 * **Idempotency.** Confirming the same intent twice applies it once. Two
 * things make that true, and the second is the one that matters:
 *
 * - One intent can only ever have one payment row
 *   (`payments_provider_intent_id_key`), so there is never an ambiguous set
 *   to confirm.
 * - The transition is a *conditional* update: `status: 'PENDING'` is part of
 *   its WHERE. Under READ COMMITTED a second confirmation blocks on the row
 *   lock, re-evaluates that WHERE against the committed row and matches
 *   nothing, so it applies no money. Reading the status first and then
 *   writing unconditionally would let two deliveries that both read `PENDING`
 *   both pay -- and Stripe does deliver twice.
 *
 * The second call is not an error: it returns the payment as it stands, so a
 * webhook can answer 200 and stop Stripe retrying.
 */
export async function confirmPayment(
  db: Db,
  input: ConfirmPaymentInput
): Promise<Result<PaymentDto>> {
  return db.$transaction((tx: DbTransactionClient) => confirmPaymentWithin(tx, input));
}

/**
 * `confirmPayment`'s body, running inside a transaction the caller already
 * owns rather than opening one of its own.
 *
 * Exists for the Stripe webhook (Task 10), which cannot use
 * `confirmPayment`: the `StripeEvent` row that makes the whole delivery
 * idempotent has to be inserted **first and in the same transaction** as
 * the money it authorises, and a function that opens its own transaction
 * can never be part of that one. `confirmPayment` is now a two-line wrapper
 * around this, so the counter and the webhook still confirm a payment
 * through one piece of code.
 */
export async function confirmPaymentWithin(
  tx: DbTransactionClient,
  input: ConfirmPaymentInput
): Promise<Result<PaymentDto>> {
  const payment = await tx.payment.findUnique({
    where: { providerIntentId: input.providerIntentId },
  });

  if (!payment) {
    // No row for this intent. See `ConfirmPaymentInput.recordIfMissing`:
    // when the caller knows what the money was for, record it rather than
    // answering NOT_FOUND and losing a payment that really happened.
    if (!input.recordIfMissing) return fail('NOT_FOUND', { field: 'providerIntentId' });
    return recordPayment(tx, {
      ...input.recordIfMissing,
      status: 'SUCCEEDED',
      providerIntentId: input.providerIntentId,
      paidAt: input.paidAt,
    });
  }

  if (payment.status === 'SUCCEEDED') return ok(toDto(payment));
  // FAILED, EXPIRED and REFUNDED are decided elsewhere and are not
  // something a `succeeded` event may quietly undo.
  if (payment.status !== 'PENDING') {
    return fail('INVALID_STATUS_TRANSITION', { status: payment.status });
  }

  const confirmed = await tx.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status: 'SUCCEEDED', paidAt: input.paidAt },
  });
  if (confirmed.count === 0) {
    // Another confirmation won the race and already applied the money. Its
    // row, its timestamp, its audit entry.
    return ok(toDto(await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })));
  }

  // After the conditional update, never before: a confirmation that lost the
  // race above must not take a number it will not use, or the year's
  // sequence would have a gap.
  const receiptNumber = await assignReceiptNumber(tx, input.paidAt);
  const reservation = await applyConfirmedPayment(tx, payment.reservationId, payment.amountCents);
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      receiptNumber,
      receiptTotalCents: reservation.totalPriceCents,
      receiptPaidCents: reservation.paidCents,
    },
  });

  await recordAudit(tx, {
    action: 'payment.confirmed',
    entityType: 'Payment',
    entityId: payment.id,
    // Serialised rather than handed over as `Date`: the audit columns are
    // `jsonb`, and the `after` side next to it is a string too.
    before: { status: payment.status, paidAt: payment.paidAt?.toISOString() ?? null },
    after: { status: 'SUCCEEDED', paidAt: input.paidAt.toISOString() },
  });

  return ok(toDto({ ...payment, status: 'SUCCEEDED', paidAt: input.paidAt, receiptNumber }));
}

/**
 * Every payment of one customer across all their reservations, newest first.
 *
 * Ordered by `recorded_at` and not by `paid_at`: a pending OXXO voucher has
 * no `paid_at` at all and is the most actionable row on the screen, so
 * ordering by it would push exactly the wrong row to the bottom.
 *
 * Failed and expired payments are included. They are the customer's history
 * too, and a card that was declined is something they should be able to see
 * rather than wonder about.
 */
export async function listPaymentsForCustomer(
  db: Db,
  customerId: string
): Promise<Result<PaymentDto[]>> {
  const payments = await db.payment.findMany({
    where: { reservation: { customerId } },
    orderBy: { recordedAt: 'desc' },
  });
  return ok(payments.map(toDto));
}

/**
 * Every payment of one reservation, newest first -- the history the panel's
 * reservation detail shows staff (Task 19). Same order and same inclusions
 * as `listPaymentsForCustomer`: by `recorded_at`, failed, expired and pending
 * rows included, because a person deciding a cancellation needs to see the
 * OXXO voucher that is still outstanding as much as the money that arrived.
 *
 * An unknown reservation is `NOT_FOUND`, not an empty list: "no payments yet"
 * and "no such reservation" are different answers for a screen to give.
 */
export async function listPaymentsForReservation(
  db: Db,
  reservationId: string
): Promise<Result<PaymentDto[]>> {
  const reservation = await db.reservation.findUnique({ where: { id: reservationId }, select: { id: true } });
  if (!reservation) return fail('NOT_FOUND');
  const payments = await db.payment.findMany({ where: { reservationId }, orderBy: { recordedAt: 'desc' } });
  return ok(payments.map(toDto));
}

/**
 * The instalment to suggest for one reservation right now (business rule
 * 5.4): its balance spread over the first-of-month days left before the
 * payment deadline, in the organisation's timezone.
 *
 * Recomputed on every read and never stored -- there is no column for it, and
 * a stored copy would be stale the moment a payment landed. See
 * `suggestedMonthly` for the arithmetic and why it rounds up.
 */
export async function suggestedMonthlyForReservation(
  db: Db,
  reservationId: string
): Promise<Result<number>> {
  const reservation = await db.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return fail('NOT_FOUND');

  const timeZone = await organizationTimeZone(db);
  const months = monthStartsBetween(
    new Date(),
    endOfCalendarDay(reservation.paymentDeadline, timeZone),
    timeZone
  );
  return ok(suggestedMonthly(balanceOf(reservation), months));
}
