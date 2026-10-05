import { z } from 'zod';
import { uuidSchema } from './common';

export const reservationStatusSchema = z.enum(['HELD', 'ACTIVE', 'CANCELLED', 'EXPIRED']);

export const createReservationRequestSchema = z.object({
  tripId: uuidSchema,
});

/**
 * No field here ever changes `status` -- see
 * `docs/business-rules/reservations.md`, "Solicitar la cancelación": asking
 * only seals `cancellation_requested_at` and notifies staff, who decide from
 * the panel.
 */
export const requestCancellationRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

/** Response shape for one reservation, in full -- what the customer's own detail screen reads. */
export const reservationSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  tripId: uuidSchema,
  customerId: uuidSchema,
  status: reservationStatusSchema,
  holdExpiresAt: z.iso.datetime().nullable(),
  totalPriceCents: z.number().int(),
  minimumDepositCents: z.number().int(),
  paidCents: z.number().int(),
  creditCents: z.number().int(),
  balanceCents: z.number().int(),
  paymentDeadline: z.iso.datetime(),
  cancellationRequestedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/** The list row: drops the detail-only fields `ReservationDto` carries (see `@rm/domain-reservations`). */
export const reservationSummarySchema = z.object({
  id: uuidSchema,
  code: z.string(),
  tripId: uuidSchema,
  status: reservationStatusSchema,
  holdExpiresAt: z.iso.datetime().nullable(),
  totalPriceCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  paymentDeadline: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;
export type RequestCancellationRequest = z.infer<typeof requestCancellationRequestSchema>;
export type ReservationContract = z.infer<typeof reservationSchema>;
export type ReservationSummaryContract = z.infer<typeof reservationSummarySchema>;
