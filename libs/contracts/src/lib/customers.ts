import { z } from 'zod';
import { localeSchema, uuidSchema } from './common';
import { reservationStatusSchema } from './reservations';

export const customerOriginSchema = z.enum(['SELF_SIGNUP', 'BRANCH', 'IMPORT']);

/** The query of `GET /api/v1/admin/customers`. Validated by hand in the route, like the other list endpoints. */
export const searchCustomersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

/** A row of the panel's customer search, matching `CustomerSummaryDto`. */
export const customerSummarySchema = z.object({
  id: uuidSchema,
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  origin: customerOriginSchema,
  activatedAt: z.iso.datetime().nullable(),
  invitedAt: z.iso.datetime().nullable(),
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const customerPageSchema = z.object({
  items: z.array(customerSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

export const customerReservationSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  status: reservationStatusSchema,
  tripName: z.string(),
  departureDate: z.iso.datetime(),
  totalPriceCents: z.number().int(),
  paidCents: z.number().int(),
  createdAt: z.iso.datetime(),
});

/** One customer for the panel, matching `CustomerDetailDto`. */
export const customerDetailSchema = customerSummarySchema.extend({
  birthDate: z.iso.datetime(),
  locale: localeSchema,
  emailVerifiedAt: z.iso.datetime().nullable(),
  acceptedTermsAt: z.iso.datetime().nullable(),
  reservations: z.array(customerReservationSchema),
});

export const createdCustomerSchema = customerDetailSchema.extend({
  invitationSent: z.boolean(),
});

/** The body of `POST /api/v1/admin/customers`: registering a customer at the counter. */
export const createBranchCustomerRequestSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().min(7).max(30),
  birthDate: z.iso.date(),
  locale: localeSchema.optional(),
  /** Send the activation invitation right away. Staff untick it when the customer has no email at hand. */
  sendInvitation: z.boolean().default(true),
});

/** The body of `POST /api/v1/auth/invitation/accept`. */
export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(10).max(128),
  // `z.literal(true)`, same as registration: accepting the invitation is
  // accepting the terms.
  acceptTerms: z.literal(true),
});

export const acceptedInvitationSchema = z.object({ email: z.string() });

export type SearchCustomersQuery = z.infer<typeof searchCustomersQuerySchema>;
export type CustomerSummaryContract = z.infer<typeof customerSummarySchema>;
export type CustomerPageContract = z.infer<typeof customerPageSchema>;
export type CustomerDetailContract = z.infer<typeof customerDetailSchema>;
export type CreatedCustomerContract = z.infer<typeof createdCustomerSchema>;
export type CreateBranchCustomerRequest = z.infer<typeof createBranchCustomerRequestSchema>;
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
