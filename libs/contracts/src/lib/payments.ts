import { z } from 'zod';
import { uuidSchema } from './common';
import { reservationStatusSchema } from './reservations';

export const paymentIntentKindSchema = z.enum(['FULL', 'DEPOSIT']);
export const paymentIntentMethodSchema = z.enum(['CARD', 'OXXO', 'SPEI']);
export const paymentMethodSchema = z.enum(['CARD', 'OXXO', 'SPEI', 'CASH', 'LEGACY', 'CREDIT']);
export const paymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED']);
export const paymentProviderSchema = z.enum(['STRIPE', 'MANUAL']);

/**
 * The body of `POST /reservations/{reservationId}/payment-intents`.
 *
 * **There is no amount field, on purpose.** `intent` says what the customer
 * is paying towards -- the full balance or the minimum deposit -- and the
 * backend computes the number of cents from the reservation itself
 * (`createPaymentIntentForReservation`, `@rm/domain-payments`). A schema
 * with an `amountCents` field here would be the one place a customer could
 * decide what they owe; there is deliberately nowhere for one to go.
 */
export const createPaymentIntentRequestSchema = z.object({
  intent: paymentIntentKindSchema,
  method: paymentIntentMethodSchema,
});

/** The body of `POST /api/v1/admin/reservations/{reservationId}/payments`: cash at the counter (Phase 2B). */
export const registerCashPaymentRequestSchema = z.object({
  amountCents: z.number().int().positive(),
});

export type RegisterCashPaymentRequest = z.infer<typeof registerCashPaymentRequestSchema>;

/** Response shape for one payment, matching `@rm/domain-payments`' `PaymentDto`. */
export const paymentSchema = z.object({
  id: uuidSchema,
  reservationId: uuidSchema,
  amountCents: z.number().int(),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  provider: paymentProviderSchema,
  paidAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  providerVoucherUrl: z.string().nullable(),
  voucherExpiresAt: z.iso.datetime().nullable(),
  receiptNumber: z.string().nullable(),
});

/** Response shape for a freshly created Payment Intent, matching `CreatedPaymentIntentDto`. */
export const createdPaymentIntentSchema = z.object({
  providerIntentId: z.string(),
  clientSecret: z.string(),
  amountCents: z.number().int(),
  method: paymentIntentMethodSchema,
  voucherUrl: z.string().optional(),
  voucherExpiresAt: z.iso.datetime().optional(),
});

export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequestSchema>;
export type PaymentContract = z.infer<typeof paymentSchema>;
export type CreatedPaymentIntentContract = z.infer<typeof createdPaymentIntentSchema>;

// --- Pending vouchers: the counter's "money to chase" queue ------------------

/**
 * The query string of `GET /api/v1/admin/payments`. `status` accepts only
 * `PENDING` today (and defaults to it): the list is the OXXO and SPEI vouchers
 * still waiting to be paid, never card intents, so `method` can only narrow it
 * to one of the two.
 */
export const listStaffPaymentsQuerySchema = z.object({
  status: z.literal('PENDING').default('PENDING'),
  method: z.enum(['OXXO', 'SPEI']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** One pending voucher with what the counter needs to chase it, matching `@rm/domain-payments`' `StaffPaymentRowDto`. */
export const staffPaymentRowSchema = paymentSchema.extend({
  reservationCode: z.string(),
  reservationStatus: reservationStatusSchema,
  customerId: uuidSchema,
  customerName: z.string(),
  tripName: z.string(),
  createdAt: z.iso.datetime(),
});

/** One page of pending vouchers, matching `StaffPaymentPageDto`. */
export const staffPaymentPageSchema = z.object({
  items: z.array(staffPaymentRowSchema),
  nextCursor: z.string().nullable(),
});

export type ListStaffPaymentsQuery = z.infer<typeof listStaffPaymentsQuerySchema>;
export type StaffPaymentRowContract = z.infer<typeof staffPaymentRowSchema>;
export type StaffPaymentPageContract = z.infer<typeof staffPaymentPageSchema>;
