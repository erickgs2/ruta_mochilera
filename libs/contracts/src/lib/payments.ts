import { z } from 'zod';
import { uuidSchema } from './common';

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
