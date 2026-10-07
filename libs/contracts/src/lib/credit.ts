import { z } from 'zod';
import { uuidSchema } from './common';

export const creditEntryKindSchema = z.enum(['CANCELLATION', 'PRICE_DECREASE', 'APPLIED', 'REFUND', 'ADJUSTMENT', 'EXPIRATION', 'REVIVAL']);

/** One ledger movement, matching `@rm/domain-payments`' `CreditEntryDto`. Signed cents. */
export const creditEntrySchema = z.object({
  id: uuidSchema,
  amountCents: z.number().int(),
  kind: creditEntryKindSchema,
  reservationId: uuidSchema.nullable(),
  paymentId: uuidSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** A customer's credit: the balance and every movement behind it, newest first. */
export const customerCreditSchema = z.object({
  balanceCents: z.number().int(),
  entries: z.array(creditEntrySchema),
});

/**
 * The body of `POST /api/v1/admin/customers/{customerId}/credit/refund`:
 * money given back outside the system. Positive; the ledger stores it negative.
 */
export const refundCreditRequestSchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

/** The body of `POST /api/v1/admin/customers/{customerId}/credit/adjust`. Signed, never zero. */
export const adjustCreditRequestSchema = z.object({
  amountCents: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: 'amountCents must not be zero' }),
  reason: z.string().trim().min(1).max(500),
});

/** The body of `POST /api/v1/admin/reservations/{reservationId}/apply-credit`. */
export const applyCreditRequestSchema = z.object({
  amountCents: z.number().int().positive(),
});

export type CreditEntryContract = z.infer<typeof creditEntrySchema>;
export type CustomerCreditContract = z.infer<typeof customerCreditSchema>;
export type RefundCreditRequest = z.infer<typeof refundCreditRequestSchema>;
export type AdjustCreditRequest = z.infer<typeof adjustCreditRequestSchema>;
export type ApplyCreditRequest = z.infer<typeof applyCreditRequestSchema>;
