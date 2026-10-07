import { z } from 'zod';
import { uuidSchema } from './common';

/** One historical payment (Phase 2B, §5.7). */
export const backfilledPaymentSchema = z.object({
  amountCents: z.number().int().positive(),
  /** A calendar date `YYYY-MM-DD`; the server stamps noon of that day in the organization's time zone. */
  paidAt: z.iso.date(),
  method: z.enum(['LEGACY', 'CASH']).default('LEGACY'),
  notes: z.string().trim().max(500).optional(),
});

/** The body of `POST /api/v1/admin/backfill/reservations`. Receipts stay silent unless `sendReceipts`. */
export const backfillReservationRequestSchema = z.object({
  tripId: uuidSchema,
  customerId: uuidSchema,
  /** A calendar date `YYYY-MM-DD`, read in the organization's time zone. */
  createdAt: z.iso.date(),
  totalPriceCents: z.number().int().nonnegative().optional(),
  payments: z.array(backfilledPaymentSchema).max(200).default([]),
  sendReceipts: z.boolean().default(false),
});

/** The body of `POST /api/v1/admin/backfill/payments`: history for a reservation already in the system. */
export const backfillPaymentsRequestSchema = z.object({
  reservationId: uuidSchema,
  payments: z.array(backfilledPaymentSchema).min(1).max(200),
  sendReceipts: z.boolean().default(false),
});

export type BackfillReservationRequest = z.infer<typeof backfillReservationRequestSchema>;
export type BackfillPaymentsRequest = z.infer<typeof backfillPaymentsRequestSchema>;
