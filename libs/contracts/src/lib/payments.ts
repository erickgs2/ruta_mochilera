import { z } from 'zod';
import { uuidSchema } from './common';
import { paymentIntentMethodSchema } from './payment-options';
import { reservationStatusSchema } from './reservations';

export const paymentIntentKindSchema = z.enum(['FULL', 'DEPOSIT', 'AMOUNT']);
export const paymentMethodSchema = z.enum(['CARD', 'OXXO', 'SPEI', 'CASH', 'LEGACY', 'CREDIT']);
export const paymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED']);
export const paymentProviderSchema = z.enum(['STRIPE', 'MANUAL']);

/**
 * The body of `POST /reservations/{reservationId}/payment-intents`.
 *
 * The client proposes, the server decides (abono libre spec §3): `FULL` and
 * `DEPOSIT` carry no amount and keep their meaning; only `AMOUNT` carries one,
 * which `@rm/domain-payments` validates against the reservation and the
 * minimums before anything is charged. An amount sent with `FULL` or
 * `DEPOSIT` is dropped, so there is exactly one way to say how much.
 */
export const createPaymentIntentRequestSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('FULL'), method: paymentIntentMethodSchema }),
  z.object({ intent: z.literal('DEPOSIT'), method: paymentIntentMethodSchema }),
  z.object({
    intent: z.literal('AMOUNT'),
    method: paymentIntentMethodSchema,
    amountCents: z.number().int().positive(),
  }),
]);

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

/** SPEI instructions (Part B). Absent for CARD and OXXO. */
export const bankTransferSchema = z.object({
  clabe: z.string(),
  reference: z.string(),
  bankName: z.string(),
  amountRemainingCents: z.number().int(),
  hostedInstructionsUrl: z.string(),
  expiresAt: z.iso.datetime(),
});

/** Response shape for a freshly created Payment Intent, matching `CreatedPaymentIntentDto`. */
export const createdPaymentIntentSchema = z.object({
  providerIntentId: z.string(),
  clientSecret: z.string(),
  amountCents: z.number().int(),
  method: paymentIntentMethodSchema,
  voucherUrl: z.string().optional(),
  voucherExpiresAt: z.iso.datetime().optional(),
  bankTransfer: bankTransferSchema.optional(),
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
