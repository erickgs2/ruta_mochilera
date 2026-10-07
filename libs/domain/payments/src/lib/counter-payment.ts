import type { Db, DbTransactionClient } from '@rm/db';
import { fail, type Result } from '@rm/shared-utils';
import { recordPayment, type PaymentDto } from './payment-service';
import { enqueueReceipt, type ReceiptQueue } from './receipt-service';
import { reviveForPayment } from './credit-service';
import { RollbackWith, rollbackable, type ReviveReservation } from './revival';

/**
 * Cash at the counter (Phase 2B, business rule 5.3): a `CASH` payment,
 * `provider = MANUAL`, SUCCEEDED on the spot, `recorded_by` = the staff
 * member, `paid_at` = now -- with its receipt number and receipt job in the
 * same transaction.
 */

export interface RegisterCashPaymentInput {
  reservationId: string;
  amountCents: number;
  actorId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function recordCash(
  tx: DbTransactionClient,
  queue: ReceiptQueue,
  input: RegisterCashPaymentInput
): Promise<Result<PaymentDto>> {
  const payment = await recordPayment(tx, {
    reservationId: input.reservationId,
    amountCents: input.amountCents,
    method: 'CASH',
    status: 'SUCCEEDED',
    provider: 'MANUAL',
    recordedById: input.actorId,
  });
  if (payment.ok) await enqueueReceipt(tx, queue, payment.value.id);
  return payment;
}

/**
 * Takes cash for an existing reservation.
 *
 * - Amount `> 0` and `≤` the balance (`PAYMENT_EXCEEDS_BALANCE`), like every
 *   payment.
 * - Only on a live reservation. On a `CANCELLED` one it is
 *   `INVALID_STATUS_TRANSITION`: money from a customer with no live
 *   reservation is recorded as credit (an `ADJUSTMENT`), never as a payment
 *   on a dead reservation.
 * - **A hold that already ran out** (a `HELD` past its time, or an `EXPIRED`
 *   reservation) is revived when the caller injects `reviveReservation`
 *   (decision 13): if a seat is left under the trip's lock the reservation
 *   becomes `HELD` with a fresh hold, the credit its expiry had produced is
 *   taken back, and this payment is recorded on it -- all in one transaction,
 *   rolled back whole if any step fails (`TRIP_SOLD_OUT` leaves nothing
 *   written). Without the hook the old answer stands: `HOLD_EXPIRED`, or
 *   `INVALID_STATUS_TRANSITION` for an `EXPIRED` one.
 * - A `HELD` reservation that this payment brings to its deposit becomes
 *   `ACTIVE`, through the same conditional update the webhook uses.
 */
export async function registerCashPayment(
  db: Db,
  queue: ReceiptQueue,
  input: RegisterCashPaymentInput,
  reviveReservation?: ReviveReservation
): Promise<Result<PaymentDto>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');

  return rollbackable(db, async (tx: DbTransactionClient): Promise<Result<PaymentDto>> => {
    // Lock order: trip, reservation, customer. Reviving takes the trip first,
    // so it runs before this transaction locks the reservation.
    let revived = false;
    if (reviveReservation) {
      const brought = await reviveForPayment(tx, reviveReservation, {
        reservationId: input.reservationId,
        actorId: input.actorId,
      });
      if (!brought.ok) return brought;
      revived = brought.value.revived;
    }

    await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${input.reservationId}::uuid FOR UPDATE`;
    const reservation = await tx.reservation.findUnique({ where: { id: input.reservationId } });
    if (!reservation) return fail('NOT_FOUND');
    if (reservation.status !== 'HELD' && reservation.status !== 'ACTIVE') {
      return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
    }
    if (
      !reviveReservation &&
      reservation.status === 'HELD' &&
      reservation.holdExpiresAt &&
      reservation.holdExpiresAt <= new Date()
    ) {
      return fail('HOLD_EXPIRED');
    }
    const paid = await recordCash(tx, queue, input);
    // The revival is already written: a refusal here must undo it too.
    if (!paid.ok && revived) throw new RollbackWith(paid);
    return paid;
  });
}

/**
 * The hook `createBranchReservation` (`@rm/domain-reservations`) receives to
 * take the first cash payment inside the reservation's own transaction. The
 * reservation was created a moment ago in that transaction, so it is live
 * by construction.
 */
export function createInitialCashPayment(queue: ReceiptQueue) {
  return (tx: DbTransactionClient, input: RegisterCashPaymentInput): Promise<Result<PaymentDto>> =>
    recordCash(tx, queue, input);
}
