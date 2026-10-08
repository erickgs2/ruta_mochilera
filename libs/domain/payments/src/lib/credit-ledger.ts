import type { CreditEntryKind, CustomerCreditEntry, Db, DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { fail, ok, type Result } from '@rm/shared-utils';

/**
 * The customer credit ledger's primitives (Phase 2B, business rule 5.5):
 * the customer lock, the balance under it, and the one function that writes
 * an entry. A leaf inside this library -- it imports nothing from the other
 * payment modules -- so `payment-service.ts` can credit money while it
 * settles a payment, and `credit-service.ts` (which records payments) can
 * build on both without the two importing each other.
 *
 * A customer's balance is the sum of their `customer_credit_entries`, never
 * an editable column. Every write locks the customer's profile row first and
 * computes the sum under that lock, the same way a trip's seats are counted
 * under a lock on the trip: two writers for the same customer queue up, and
 * the second one sees the first one's entry. An entry that would take the sum
 * below zero is refused with `CREDIT_INSUFFICIENT`.
 *
 * The customer lock has its place in the one lock order every money path
 * follows; see "Lock order" in `payment-service.ts`.
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

export interface CreditFromCancellationInput {
  customerId: string;
  reservationId: string;
  amountCents: number;
  /** Set when the money is one late payment rather than the whole reservation. */
  paymentId?: string;
  actorId?: string;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toCreditEntryDto(entry: CustomerCreditEntry): CreditEntryDto {
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
export async function lockCustomer(tx: DbTransactionClient, customerId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(customerId)) return false;
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM customer_profiles WHERE user_id = ${customerId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

export function normalizedReason(reason: string | undefined): string | null {
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

/**
 * Writes one ledger entry inside the caller's transaction, under the
 * customer lock, and audits it. Every ledger write in this library ends here.
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

  return ok(toCreditEntryDto(entry));
}

/**
 * The money a cancelled reservation had received becomes the customer's
 * credit (`CANCELLATION`). Written in the caller's transaction:
 *
 * - `cancelReservation` (`@rm/domain-reservations`) receives it **injected**
 *   -- the two domains do not import each other -- and calls it once, on the
 *   call that actually cancelled, with the `paid_cents` read under the lock.
 * - Settling a payment that arrives after the cancellation
 *   (`payment-service.ts`) calls it with `paymentId`. With a `paymentId` it is
 *   idempotent per payment.
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

/**
 * The part of a provider-confirmed payment above what its reservation still
 * owed becomes the customer's credit (`OVERPAYMENT`, owner decision D7),
 * tied to that payment. Written by `payment-service.ts` while it settles the
 * payment, under the reservation lock its caller holds; this takes the
 * customer's.
 *
 * Only the delivery that wins a payment's `PENDING -> SUCCEEDED` transition
 * settles it, so this runs once per payment; the partial unique index
 * `customer_credit_entries_overpayment_payment_id_key` is the net behind
 * that, and a second write aborts the transaction instead of crediting twice.
 */
export async function creditFromOverpayment(
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; paymentId: string; amountCents: number }
): Promise<void> {
  if (input.amountCents <= 0) return;
  const entry = await addCreditEntry(tx, {
    customerId: input.customerId,
    amountCents: input.amountCents,
    kind: 'OVERPAYMENT',
    reservationId: input.reservationId,
    paymentId: input.paymentId,
  });
  // A positive entry is only refused for a customer that does not exist,
  // which a reservation pointing at them rules out.
  if (!entry.ok) throw new Error(`Overpayment credit refused: ${entry.error.code}`);
}
