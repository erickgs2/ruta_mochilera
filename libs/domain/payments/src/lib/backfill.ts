import type { Db, DbTransactionClient } from '@rm/db';
import { organizationTimeZone } from '@rm/domain-settings';
import { fail, ok, resolveBackfillMoments, type Result } from '@rm/shared-utils';
import { recordPayment, type PaymentDto } from './payment-service';
import { enqueueReceipt, type ReceiptQueue } from './receipt-service';

/**
 * Historical payments (Phase 2B, business rule 5.7, `data.backfill`): money
 * that arrived before the system existed. `LEGACY` (or `CASH` when it is
 * known), `paid_at` in the past, `is_backfilled`, numbered in the year of
 * their `paid_at` like any other SUCCEEDED payment. **Receipts are silent by
 * default**: none is queued unless staff ticked the box.
 *
 * Either one opening payment with everything already paid, or the payments
 * one by one -- the same function takes a list of one or of many.
 */

export interface BackfilledPaymentInput {
  amountCents: number;
  /**
   * When the money arrived. A `YYYY-MM-DD` string is a calendar day as staff
   * picked it: the domain stamps it at noon in the organization's zone, never
   * after now, and refuses a day after today in that zone
   * (`resolveBackfillMoments`). A `Date` is an instant already decided (the CSV
   * import stamps its own) and is only checked not to be in the future.
   */
  paidAt: Date | string;
  /** `LEGACY` when unknown; an import may also say how it was really paid. */
  method: 'LEGACY' | 'CASH' | 'CARD' | 'OXXO' | 'SPEI';
  notes?: string;
  /** An import's own reference: the same one is never imported twice. */
  externalRef?: string;
}

export interface RecordBackfilledPaymentsInput {
  reservationId: string;
  actorId: string;
  payments: BackfilledPaymentInput[];
  sendReceipts: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Carries a failed `Result` out of a transaction so the transaction rolls back. */
class RollbackWith extends Error {
  constructor(readonly result: Result<never>) {
    super('rolled back');
  }
}

type StampedPayment = Omit<BackfilledPaymentInput, 'paidAt'> & { paidAt: Date };

/**
 * Turns the calendar days of a capture into instants, in the organization's
 * time zone. The rule is the domain's, not the HTTP layer's: the Route Handler
 * passes the strings it validated and a second caller inherits the rule.
 */
async function stamp(
  client: DbTransactionClient,
  payments: BackfilledPaymentInput[]
): Promise<Result<StampedPayment[]>> {
  const days = payments.flatMap((payment, index) =>
    typeof payment.paidAt === 'string' ? [{ index, field: `payments.${index}.paidAt`, date: payment.paidAt }] : []
  );
  if (days.length === 0) return ok(payments as StampedPayment[]);

  const moments = resolveBackfillMoments(days, await organizationTimeZone(client));
  if (!moments.ok) return moments;
  const stamped = payments.map((payment) => ({ ...payment })) as StampedPayment[];
  days.forEach((day, position) => {
    (stamped[day.index] as StampedPayment).paidAt = moments.value[position] as Date;
  });
  return ok(stamped);
}

function validate(payments: StampedPayment[]): Result<null> {
  if (payments.length === 0) return fail('VALIDATION_FAILED', { field: 'payments' });
  const now = Date.now();
  for (const [index, payment] of payments.entries()) {
    if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0) {
      return fail('VALIDATION_FAILED', { field: `payments.${index}.amountCents` });
    }
    if (Number.isNaN(payment.paidAt.getTime()) || payment.paidAt.getTime() > now) {
      return fail('VALIDATION_FAILED', { field: `payments.${index}.paidAt` });
    }
  }
  return ok(null);
}

/**
 * Writes the payments inside the caller's transaction, oldest first (so each
 * receipt's balance snapshot follows the real order). A failed `Result` means
 * the caller must roll back: earlier payments of the list may already be
 * written.
 */
export async function recordBackfilledPaymentsWithin(
  tx: DbTransactionClient,
  queue: ReceiptQueue,
  input: RecordBackfilledPaymentsInput
): Promise<Result<PaymentDto[]>> {
  const stamped = await stamp(tx, input.payments);
  if (!stamped.ok) return stamped;
  const valid = validate(stamped.value);
  if (!valid.ok) return valid;

  const recorded: PaymentDto[] = [];
  for (const payment of [...stamped.value].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())) {
    const result = await recordPayment(tx, {
      reservationId: input.reservationId,
      amountCents: payment.amountCents,
      method: payment.method,
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      paidAt: payment.paidAt,
      recordedById: input.actorId,
      notes: payment.notes,
      isBackfilled: true,
      externalRef: payment.externalRef,
    });
    if (!result.ok) return result;
    if (input.sendReceipts) await enqueueReceipt(tx, queue, result.value.id);
    recorded.push(result.value);
  }
  return ok(recorded);
}

/**
 * The hook `createBackfilledReservation` (`@rm/domain-reservations`)
 * receives, closing over the payments and the receipts choice.
 */
export function createBackfilledPaymentsHook(
  queue: ReceiptQueue,
  payments: BackfilledPaymentInput[],
  sendReceipts: boolean
) {
  return (tx: DbTransactionClient, ids: { reservationId: string; actorId: string }) =>
    recordBackfilledPaymentsWithin(tx, queue, { ...ids, payments, sendReceipts });
}

/**
 * Historical payments for a reservation already in the system, in their own
 * transaction: all of them or none. Only on a live reservation -- money on a
 * cancelled one is credit, not a payment (same rule as cash at the counter).
 */
export async function recordBackfilledPayments(
  db: Db,
  queue: ReceiptQueue,
  input: RecordBackfilledPaymentsInput
): Promise<Result<PaymentDto[]>> {
  const stamped = await stamp(db, input.payments);
  if (!stamped.ok) return stamped;
  const valid = validate(stamped.value);
  if (!valid.ok) return valid;
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');

  try {
    return await db.$transaction(async (tx: DbTransactionClient): Promise<Result<PaymentDto[]>> => {
      const reservation = await tx.reservation.findUnique({
        where: { id: input.reservationId },
        select: { status: true },
      });
      if (!reservation) return fail('NOT_FOUND');
      if (reservation.status !== 'HELD' && reservation.status !== 'ACTIVE') {
        return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
      }
      const recorded = await recordBackfilledPaymentsWithin(tx, queue, { ...input, payments: stamped.value });
      if (!recorded.ok) throw new RollbackWith(recorded);
      return recorded;
    });
  } catch (error) {
    if (error instanceof RollbackWith) return error.result;
    throw error;
  }
}
