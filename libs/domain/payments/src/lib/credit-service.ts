import type { Db, DbTransactionClient } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import {
  addCreditEntry,
  creditBalance,
  lockCustomer,
  normalizedReason,
  toCreditEntryDto,
  UUID_PATTERN,
  type CreditEntryDto,
} from './credit-ledger';
import { recordPayment, type PaymentDto } from './payment-service';
import { lockReservationForMoney } from './reservation-lock';
import { enqueueReceipt, type ReceiptQueue } from './receipt-service';
import { RollbackWith, rollbackable, type ReviveReservation } from './revival';

/**
 * The customer credit ledger (Phase 2B, business rule 5.5): the operations
 * staff and the jobs perform on it. The primitives -- the customer lock, the
 * balance under it and `addCreditEntry` -- live in `credit-ledger.ts`, and
 * are re-exported here so the library's public surface did not move.
 *
 * Every operation that touches a reservation and the ledger follows the one
 * lock order of every money path; see "Lock order" in `payment-service.ts`.
 */

export {
  addCreditEntry,
  creditBalance,
  creditFromCancellation,
  type AddCreditEntryInput,
  type CreditEntryDto,
  type CreditFromCancellationInput,
} from './credit-ledger';

export interface CustomerCreditDto {
  balanceCents: number;
  entries: CreditEntryDto[];
}

export interface CreditMovementInput {
  customerId: string;
  amountCents: number;
  reason: string;
  actorId: string;
}

export interface ApplyCreditInput {
  /**
   * Whose credit to spend. The reservation's own customer when omitted (the
   * panel's case); when given, it must be that customer.
   */
  customerId?: string;
  reservationId: string;
  amountCents: number;
  actorId: string;
}

/** Balance plus every movement, newest first -- what staff and the customer see. */
export async function listCreditEntries(db: Db, customerId: string): Promise<Result<CustomerCreditDto>> {
  if (!UUID_PATTERN.test(customerId)) return fail('NOT_FOUND');
  const customer = await db.customerProfile.findUnique({
    where: { userId: customerId },
    select: { userId: true },
  });
  if (!customer) return fail('NOT_FOUND');

  const entries = await db.customerCreditEntry.findMany({
    where: { customerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return ok({
    balanceCents: entries.reduce((sum, entry) => sum + entry.amountCents, 0),
    entries: entries.map(toCreditEntryDto),
  });
}

/**
 * Money that was given back to the customer **outside the system** (cash,
 * a bank transfer): the credit goes down by that amount. The reason is
 * mandatory -- it is the only trace of where the money went.
 */
export async function refundCredit(db: Db, input: CreditMovementInput): Promise<Result<CreditEntryDto>> {
  if (!normalizedReason(input.reason)) return fail('VALIDATION_FAILED', { field: 'reason' });
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }
  return db.$transaction((tx: DbTransactionClient) =>
    addCreditEntry(tx, {
      customerId: input.customerId,
      amountCents: -input.amountCents,
      kind: 'REFUND',
      reason: input.reason,
      actorId: input.actorId,
    })
  );
}

/**
 * A correction or a courtesy, in either direction (`amountCents` is signed).
 * The reason is mandatory, and a decrease cannot take the balance below zero.
 */
export async function adjustCredit(db: Db, input: CreditMovementInput): Promise<Result<CreditEntryDto>> {
  if (!normalizedReason(input.reason)) return fail('VALIDATION_FAILED', { field: 'reason' });
  return db.$transaction((tx: DbTransactionClient) =>
    addCreditEntry(tx, {
      customerId: input.customerId,
      amountCents: input.amountCents,
      kind: 'ADJUSTMENT',
      reason: input.reason,
      actorId: input.actorId,
    })
  );
}

/**
 * Pays part of a live reservation with the customer's credit.
 *
 * One transaction writes a `CREDIT` payment through `recordPayment` -- so it
 * gets a receipt number (and its receipt is enqueued), moves `paid_cents` and activates a `HELD`
 * reservation that now covers its deposit, exactly like cash would -- and
 * the matching `APPLIED` entry. `paid_cents` therefore stays the sum of
 * SUCCEEDED payments and the nightly reconciliation needs no special case.
 *
 * Never more than the customer's credit (`CREDIT_INSUFFICIENT`) nor than the
 * reservation's balance (`PAYMENT_EXCEEDS_BALANCE`). Only to the customer's
 * own reservation (`RESERVATION_NOT_OWNED`), and only while it is live.
 *
 * **A hold that already ran out** (a `HELD` past its time, or an `EXPIRED`
 * reservation) is revived when the caller injects `reviveReservation`
 * (decision 13), exactly as for cash: a seat left under the trip's lock, the
 * credit its expiry produced taken back first, then this payment -- one
 * transaction, rolled back whole if any step fails. The balance checked is the
 * one after that reclaim. Without the hook the old answer stands
 * (`HOLD_EXPIRED`, or `INVALID_STATUS_TRANSITION` for an `EXPIRED` one).
 */
export async function applyCreditToReservation(
  db: Db,
  queue: ReceiptQueue,
  input: ApplyCreditInput,
  reviveReservation?: ReviveReservation
): Promise<Result<PaymentDto>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');

  // The owner never changes: refuse a stranger's reservation before anything
  // is locked or revived.
  if (input.customerId !== undefined) {
    const owner = await db.reservation.findUnique({ where: { id: input.reservationId }, select: { customerId: true } });
    if (owner && owner.customerId !== input.customerId) return fail('RESERVATION_NOT_OWNED');
  }

  return rollbackable(db, async (tx: DbTransactionClient): Promise<Result<PaymentDto>> => {
    // See "Lock order" in `payment-service.ts`: trip (inside the revival),
    // reservation, customer, and the receipt counter last (`recordPayment`).
    let revived = false;
    const refuse = <T>(result: Result<T>): Result<T> => {
      // The revival is already written: a refusal must undo it too.
      if (revived && !result.ok) throw new RollbackWith(result);
      return result;
    };
    if (reviveReservation) {
      const brought = await reviveForPayment(tx, reviveReservation, {
        reservationId: input.reservationId,
        actorId: input.actorId,
      });
      if (!brought.ok) return brought;
      revived = brought.value.revived;
    }

    await lockReservationForMoney(tx, input.reservationId);
    const reservation = await tx.reservation.findUnique({ where: { id: input.reservationId } });
    if (!reservation) return fail('NOT_FOUND');
    if (input.customerId !== undefined && reservation.customerId !== input.customerId) {
      return refuse(fail('RESERVATION_NOT_OWNED'));
    }
    const customerId = reservation.customerId;
    if (reservation.status !== 'HELD' && reservation.status !== 'ACTIVE') {
      return refuse(fail('INVALID_STATUS_TRANSITION', { status: reservation.status }));
    }
    if (
      !reviveReservation &&
      reservation.status === 'HELD' &&
      reservation.holdExpiresAt &&
      reservation.holdExpiresAt <= new Date()
    ) {
      return fail('HOLD_EXPIRED');
    }

    if (!(await lockCustomer(tx, customerId))) return refuse(fail('NOT_FOUND'));
    const balanceCents = await creditBalance(tx, customerId);
    if (input.amountCents > balanceCents) return refuse(fail('CREDIT_INSUFFICIENT', { balanceCents }));

    // Every refusal `recordPayment` can return happens before it writes
    // anything, so returning its failure leaves nothing to roll back
    // (apart from a revival, which `refuse` undoes).
    const payment = await recordPayment(tx, {
      reservationId: reservation.id,
      amountCents: input.amountCents,
      method: 'CREDIT',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      recordedById: input.actorId,
    });
    if (!payment.ok) return refuse(payment);

    const entry = await addCreditEntry(tx, {
      customerId,
      amountCents: -input.amountCents,
      kind: 'APPLIED',
      reservationId: reservation.id,
      paymentId: payment.value.id,
      actorId: input.actorId,
    });
    // Cannot fail: the same lock is still held and the balance was checked
    // above. Throwing rolls the payment back if that ever stops being true.
    if (!entry.ok) throw new Error(`Credit entry refused after the check: ${entry.error.code}`);

    await enqueueReceipt(tx, queue, payment.value.id);
    return payment;
  });
}

/**
 * The credit a reservation's earlier expiry left with the customer and a
 * revival has not taken back yet: the sum of its `EXPIRATION` and `REVIVAL`
 * entries. Read after the customer lock is held, like every ledger sum.
 */
async function outstandingExpirationCredit(tx: DbTransactionClient, reservationId: string): Promise<number> {
  const sum = await tx.customerCreditEntry.aggregate({
    where: { reservationId, kind: { in: ['EXPIRATION', 'REVIVAL'] } },
    _sum: { amountCents: true },
  });
  return sum._sum.amountCents ?? 0;
}

/**
 * What `expireHolds` (`apps/worker`) receives to credit an expired hold's
 * payments, typed here so the worker never reaches into the function's shape.
 */
export type CreditFromExpiration = typeof creditFromExpiration;

/**
 * The money an expired hold had received becomes the customer's credit
 * (`EXPIRATION`, business rule 5.3), written in `expireHolds`' own
 * transaction, on the call that actually expired the reservation -- the same
 * shape as `creditFromCancellation`, injected into the worker the same way.
 *
 * `paid_cents` stays where it is (the reservation keeps its payments, like a
 * cancelled one), so what is credited is the part of it **not yet credited**:
 * `paid_cents` minus the outstanding `EXPIRATION`/`REVIVAL` balance of that
 * reservation. A second call for the same expiry therefore writes nothing,
 * and a reservation revived and expired again is credited its full
 * `paid_cents` again, because the revival took the first credit back.
 *
 * The caller holds the reservation lock (its conditional update); this takes
 * the customer's: reservation first, customer second.
 */
export async function creditFromExpiration(
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; paidCents: number; actorId?: string }
): Promise<void> {
  if (input.paidCents <= 0) return;
  if (!(await lockCustomer(tx, input.customerId))) return;

  const missing = input.paidCents - (await outstandingExpirationCredit(tx, input.reservationId));
  if (missing <= 0) return;

  const entry = await addCreditEntry(tx, {
    customerId: input.customerId,
    amountCents: missing,
    kind: 'EXPIRATION',
    reservationId: input.reservationId,
    actorId: input.actorId,
  });
  // A positive entry is only refused for a customer that does not exist,
  // which a reservation pointing at them rules out.
  if (!entry.ok) throw new Error(`Expiration credit refused: ${entry.error.code}`);
}

/**
 * Takes back, from the customer's credit, what an expired reservation's
 * expiry credited -- the first half of reviving it (the money goes back onto
 * the reservation, where `paid_cents` never stopped counting it). Writes one
 * negative `REVIVAL` entry for the outstanding amount; nothing to take back
 * (the reservation never expired with payments, or was already revived)
 * writes nothing.
 *
 * `CREDIT_INSUFFICIENT` when the customer has already spent or been
 * refunded that credit: reviving would count the same money twice, so staff
 * settle it first with an `ADJUSTMENT`. Like every ledger write it runs under
 * the customer lock; the caller already holds the trip's and the
 * reservation's.
 */
export async function reclaimCreditForRevival(
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; actorId: string }
): Promise<Result<{ reclaimedCents: number }>> {
  if (!(await lockCustomer(tx, input.customerId))) return fail('NOT_FOUND');

  const outstanding = await outstandingExpirationCredit(tx, input.reservationId);
  if (outstanding <= 0) return ok({ reclaimedCents: 0 });

  const entry = await addCreditEntry(tx, {
    customerId: input.customerId,
    amountCents: -outstanding,
    kind: 'REVIVAL',
    reservationId: input.reservationId,
    actorId: input.actorId,
  });
  if (!entry.ok) return entry;
  return ok({ reclaimedCents: outstanding });
}

/**
 * Brings a reservation back to life for a payment about to be recorded, in the
 * caller's transaction and **before** the caller locks the reservation (the
 * seat half takes the trip's lock first: trip, reservation, customer).
 *
 * - The seat half refusing (`TRIP_SOLD_OUT`, `TRIP_NOT_PUBLISHED`,
 *   `DUPLICATE_RESERVATION`, `INVALID_STATUS_TRANSITION`) returns its failure;
 *   nothing was written.
 * - A reservation that was `EXPIRED` had its payments credited to the
 *   customer when it expired; reviving it takes that credit back
 *   (`reclaimCreditForRevival`), or `CREDIT_INSUFFICIENT` when it is gone.
 *   That failure happens after the seat was taken, so it **throws** to roll
 *   the revival back.
 *
 * `revived` tells the caller whether it now owes a rollback if anything after
 * this point fails.
 */
export async function reviveForPayment(
  tx: DbTransactionClient,
  revive: ReviveReservation,
  input: { reservationId: string; actorId: string }
): Promise<Result<{ revived: boolean }>> {
  const result = await revive(tx, input);
  if (!result.ok) return result;
  if (result.value.outcome === 'LIVE') return ok({ revived: false });

  if (result.value.previousStatus === 'EXPIRED') {
    const reservation = await tx.reservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      select: { customerId: true },
    });
    const reclaimed = await reclaimCreditForRevival(tx, {
      customerId: reservation.customerId,
      reservationId: input.reservationId,
      actorId: input.actorId,
    });
    if (!reclaimed.ok) throw new RollbackWith(reclaimed);
  }
  return ok({ revived: true });
}

/**
 * The hook `applyPriceChange` (`@rm/domain-reservations`) receives: what a
 * reservation had paid above its new, lower total becomes the customer's
 * credit (`PRICE_DECREASE`), in the price change's own transaction. The
 * caller has already taken that amount off the reservation's `paid_cents`.
 */
export async function creditFromPriceDecrease(
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; amountCents: number; actorId: string }
): Promise<void> {
  if (input.amountCents <= 0) return;
  const entry = await addCreditEntry(tx, {
    customerId: input.customerId,
    amountCents: input.amountCents,
    kind: 'PRICE_DECREASE',
    reservationId: input.reservationId,
    actorId: input.actorId,
  });
  if (!entry.ok) throw new Error(`Price decrease credit refused: ${entry.error.code}`);
}
