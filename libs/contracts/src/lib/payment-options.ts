import { z } from 'zod';

export const paymentIntentMethodSchema = z.enum(['CARD', 'OXXO', 'SPEI']);

export const paymentOptionReasonSchema = z.enum(['NOT_CONFIGURED', 'WINDOW_TOO_SHORT', 'ABOVE_PROVIDER_LIMIT', 'DISABLED']);

/**
 * What the app needs to offer a payment without re-implementing the rules
 * (abono libre spec §4.2). Informative: the POST decides.
 *
 * Its own file, not `payments.ts`, because `reservations.ts` embeds it and
 * `payments.ts` already imports from `reservations.ts`: two modules reading
 * each other's constants at load time would leave one of them undefined.
 */
export const paymentOptionsSchema = z.object({
  minAmountCents: z.number().int(),
  maxAmountCents: z.number().int(),
  depositOwedCents: z.number().int(),
  methods: z.array(
    z.object({
      method: paymentIntentMethodSchema,
      available: z.boolean(),
      reason: paymentOptionReasonSchema.optional(),
    })
  ),
});

export type PaymentOptionsContract = z.infer<typeof paymentOptionsSchema>;
