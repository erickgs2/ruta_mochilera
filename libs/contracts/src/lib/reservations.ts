import { z } from 'zod';
import { uuidSchema } from './common';

export const reservationStatusSchema = z.enum(['HELD', 'ACTIVE', 'CANCELLED', 'EXPIRED']);

export const createReservationRequestSchema = z.object({
  tripId: uuidSchema,
});

/**
 * The body of `POST /api/v1/admin/reservations` (Phase 2B): a reservation
 * taken at the counter for a customer. With `initialPaymentCents`, the first
 * cash payment is recorded with it (and `payment.register` is required too);
 * without it, the reservation is only held.
 */
export const createBranchReservationRequestSchema = z.object({
  tripId: uuidSchema,
  customerId: uuidSchema,
  initialPaymentCents: z.number().int().positive().optional(),
});

export type CreateBranchReservationRequest = z.infer<typeof createBranchReservationRequestSchema>;

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
  balanceCents: z.number().int(),
  paymentDeadline: z.iso.datetime(),
  cancellationRequestedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * What `POST /reservations` and `GET /reservations/{id}` answer: the full
 * reservation plus the suggested monthly payment, recomputed on every read
 * and never stored (see `docs/business-rules/payments.md`, "Mensualidad
 * sugerida"). The cancellation-request response keeps the plain shape.
 */
export const reservationDetailSchema = reservationSchema.extend({
  suggestedMonthlyCents: z.number().int(),
});

/** The list row: drops the detail-only fields `ReservationDto` carries (see `@rm/domain-reservations`). */
export const reservationSummarySchema = z.object({
  id: uuidSchema,
  code: z.string(),
  tripId: uuidSchema,
  tripName: z.string(),
  tripDepartureDate: z.iso.datetime(),
  status: reservationStatusSchema,
  holdExpiresAt: z.iso.datetime().nullable(),
  totalPriceCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  paymentDeadline: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

/**
 * The query string of `GET /api/v1/admin/reservations` (Task 19). Like
 * `listInboxQuerySchema`, the route validates against this exact object and
 * `registry.ts` documents it, so the two cannot drift apart.
 * `cancellationPending` arrives as the strings `true`/`false`; anything
 * else is a validation failure, never a silent "no filter".
 */
export const listStaffReservationsQuerySchema = z.object({
  tripId: uuidSchema.optional(),
  status: reservationStatusSchema.optional(),
  cancellationPending: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/**
 * The body of `POST /api/v1/admin/reservations/{reservationId}/cancel`. The
 * reason is required: it is what the customer reads in their notice and what
 * the audit entry keeps of the decision.
 */
export const cancelReservationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/**
 * The body of `POST /api/v1/admin/reservations/{reservationId}/decline-cancellation`.
 * Required for the same reason as a cancellation's: the customer reads it in
 * their notice.
 */
export const declineCancellationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/** A row of the panel's reservation list, matching `StaffReservationSummaryDto`. */
export const staffReservationSummarySchema = z.object({
  id: uuidSchema,
  code: z.string(),
  tripId: uuidSchema,
  tripName: z.string(),
  tripDepartureDate: z.iso.datetime(),
  customerId: uuidSchema,
  customerName: z.string(),
  status: reservationStatusSchema,
  holdExpiresAt: z.iso.datetime().nullable(),
  totalPriceCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  paymentDeadline: z.iso.datetime(),
  cancellationRequestedAt: z.iso.datetime().nullable(),
  cancellationPending: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** One reservation as the panel's detail screen reads it, matching `StaffReservationDetailDto`. */
export const staffReservationDetailSchema = reservationSchema.extend({
  tripName: z.string(),
  tripDepartureDate: z.iso.datetime(),
  customerName: z.string(),
  customerEmail: z.string(),
  customerPhone: z.string(),
  cancellationReason: z.string().nullable(),
  cancellationPending: z.boolean(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledByName: z.string().nullable(),
  cancellationDeclinedAt: z.iso.datetime().nullable(),
  cancellationDeclinedByName: z.string().nullable(),
  cancellationDeclineReason: z.string().nullable(),
});

export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;
export type RequestCancellationRequest = z.infer<typeof requestCancellationRequestSchema>;
export type ReservationContract = z.infer<typeof reservationSchema>;
export type ReservationDetailContract = z.infer<typeof reservationDetailSchema>;
export type ReservationSummaryContract = z.infer<typeof reservationSummarySchema>;
export type ListStaffReservationsQuery = z.infer<typeof listStaffReservationsQuerySchema>;
export type DeclineCancellationRequest = z.infer<typeof declineCancellationRequestSchema>;
export type CancelReservationRequest = z.infer<typeof cancelReservationRequestSchema>;
export type StaffReservationSummaryContract = z.infer<typeof staffReservationSummarySchema>;
export type StaffReservationDetailContract = z.infer<typeof staffReservationDetailSchema>;
