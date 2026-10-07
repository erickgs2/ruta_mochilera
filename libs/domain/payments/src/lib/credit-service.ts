import type { CreditEntryKind, CustomerCreditEntry, Db, DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { fail, ok, type Result } from '@rm/shared-utils';
import { recordPayment, type PaymentDto } from './payment-service';
import { enqueueReceipt, type ReceiptQueue } from './receipt-service';

/**
 * The customer credit ledger (Phase 2B, business rule 5.5).
 *
 * A customer's balance is the sum of their `customer_credit_entries`, never
 * an editable column. Every write locks the customer's profile row first and
 * computes the sum under that lock, the same way a trip's seats are counted
 * under a lock on the trip: two writers for the same customer queue up, and
 * the second one sees the first one's entry. An entry that would take the sum
 * below zero is refused with `CREDIT_INSUFFICIENT`.
 *
 * **Lock order.** An operation that touches both a reservation and the
 * ledger (applying credit, cancelling, changing a price) locks the
 * reservation first and the customer second. Keeping one order everywhere is
 * what keeps two of them from deadlocking.
 */

export interface CreditEntryDto {
  id: string;
  amountCents: number;
  kind: CreditEntryKind;
  reservationId: string | null;
  paymentId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface CustomerCreditDto {
  balanceCents: number;
  entries: CreditEntryDto[];
}

export interface AddCreditEntryInput {
  customerId: string;
  /** Signed, never zero. */
  amountCents: number;
  kind: CreditEntryKind;
  reservationId?: string;
  paymentId?: string;
  reason?: string;
  actorId?: string;
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

export interface CreditFromCancellationInput {
  customerId: string;
  reservationId: string;
  amountCents: number;
  /** Set when the money is one late payment rather than the whole reservation. */
  paymentId?: string;
  actorId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(entry: CustomerCreditEntry): CreditEntryDto {
  return {
    id: entry.id,
    amountCents: entry.amountCents,
    kind: entry.kind,
    reservationId: entry.reservationId,
    paymentId: entry.paymentId,
    reason: entry.reason,
    createdAt: entry.createdAt,
  };
}

/** True when the customer exists; their profile row stays locked until the caller commits. */
async function lockCustomer(tx: DbTransactionClient, customerId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(customerId)) return false;
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM customer_profiles WHERE user_id = ${customerId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

function normalizedReason(reason: string | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The customer's current credit, in cents. Read-only: a caller about to
 * write must go through `addCreditEntry`, which reads it under the lock.
 */
export async function creditBalance(db: Db | DbTransactionClient, customerId: string): Promise<number> {
  const sum = await db.customerCreditEntry.aggregate({
    where: { customerId },
    _sum: { amountCents: true },
  });
  return sum._sum.amountCents ?? 0;
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
    entries: entries.map(toDto),
  });
}

/**
 * Writes one ledger entry inside the caller's transaction, under the
 * customer lock, and audits it. Every other function in this file ends here.
 */
export async function addCreditEntry(
  tx: DbTransactionClient,
  input: AddCreditEntryInput
): Promise<Result<CreditEntryDto>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }
  if (!(await lockCustomer(tx, input.customerId))) return fail('NOT_FOUND');

  const balanceCents = await creditBalance(tx, input.customerId);
  if (balanceCents + input.amountCents < 0) {
    return fail('CREDIT_INSUFFICIENT', { balanceCents });
  }

  const entry = await tx.customerCreditEntry.create({
    data: {
      customerId: input.customerId,
      amountCents: input.amountCents,
      kind: input.kind,
      reservationId: input.reservationId ?? null,
      paymentId: input.paymentId ?? null,
      reason: normalizedReason(input.reason),
      createdById: input.actorId ?? null,
    },
  });

  await recordAudit(tx, {
    actorUserId: input.actorId,
    action: 'credit.entry_created',
    entityType: 'CustomerCreditEntry',
    entityId: entry.id,
    before: { balanceCents },
    after: {
      customerId: entry.customerId,
      kind: entry.kind,
      amountCents: entry.amountCents,
      reservationId: entry.reservationId,
      paymentId: entry.paymentId,
      reason: entry.reason,
      balanceCents: balanceCents + entry.amountCents,
    },
  });

  return ok(toDto(entry));
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
 * own reservation (`RESERVATION_NOT_OWNED`), only while it is live, and not
 * to a hold whose time already ran out (`HOLD_EXPIRED`): activating it would
 * take a seat the counter already gave back.
 */
export async function applyCreditToReservation(
  db: Db,
  queue: ReceiptQueue,
  input: ApplyCreditInput
): Promise<Result<PaymentDto>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail('VALIDATION_FAILED', { field: 'amountCents' });
  }
  if (!UUID_PATTERN.test(input.reservationId)) return fail('NOT_FOUND');

  return db.$transaction(async (tx: DbTransactionClient): Promise<Result<PaymentDto>> => {
    // Reservation first, customer second: see the lock order above.
    await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${input.reservationId}::uuid FOR UPDATE`;
    const reservation = await tx.reservation.findUnique({ where: { id: input.reservationId } });
    if (!reservation) return fail('NOT_FOUND');
    if (input.customerId !== undefined && reservation.customerId !== input.customerId) {
      return fail('RESERVATION_NOT_OWNED');
    }
    const customerId = reservation.customerId;
    if (reservation.status !== 'HELD' && reservation.status !== 'ACTIVE') {
      return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
    }
    if (reservation.status === 'HELD' && reservation.holdExpiresAt && reservation.holdExpiresAt <= new Date()) {
      return fail('HOLD_EXPIRED');
    }

    if (!(await lockCustomer(tx, customerId))) return fail('NOT_FOUND');
    const balanceCents = await creditBalance(tx, customerId);
    if (input.amountCents > balanceCents) return fail('CREDIT_INSUFFICIENT', { balanceCents });

    // Every refusal `recordPayment` can return happens before it writes
    // anything, so returning its failure leaves nothing to roll back.
    const payment = await recordPayment(tx, {
      reservationId: reservation.id,
      amountCents: input.amountCents,
      method: 'CREDIT',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      recordedById: input.actorId,
    });
    if (!payment.ok) return payment;

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
 * The money a cancelled reservation had received becomes the customer's
 * credit (`CANCELLATION`). Written in the caller's transaction:
 *
 * - `cancelReservation` (`@rm/domain-reservations`) receives it **injected**
 *   -- the two domains do not import each other -- and calls it once, on the
 *   call that actually cancelled, with the `paid_cents` read under the lock.
 * - The Stripe webhook calls it with `paymentId` for money that arrives after
 *   the cancellation. With a `paymentId` it is idempotent per payment.
 *
 * Nothing to credit (`amountCents <= 0`) writes nothing.
 */
export async function creditFromCancellation(
  tx: DbTransactionClient,
  input: CreditFromCancellationInput
): Promise<void> {
  if (input.amountCents <= 0) return;
  if (input.paymentId) {
    const existing = await tx.customerCreditEntry.findFirst({
      where: { paymentId: input.paymentId, kind: 'CANCELLATION' },
      select: { id: true },
    });
    if (existing) return;
  }
  const entry = await addCreditEntry(tx, {
    customerId: input.customerId,
    amountCents: input.amountCents,
    kind: 'CANCELLATION',
    reservationId: input.reservationId,
    paymentId: input.paymentId,
    actorId: input.actorId,
  });
  // A positive entry is only refused for a customer that does not exist,
  // which a reservation pointing at them rules out.
  if (!entry.ok) throw new Error(`Cancellation credit refused: ${entry.error.code}`);
}
