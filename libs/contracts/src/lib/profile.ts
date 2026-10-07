import { z } from 'zod';

/** The customer's own profile as `GET /me/profile` answers it. `email` is read-only in this phase. */
export const customerProfileSchema = z.object({
  fullName: z.string(),
  phone: z.string(),
  email: z.string().email(),
  photoUrl: z.string().nullable(),
});

/**
 * Same limits as `registerRequestSchema`. `.strict()` on purpose: sending
 * `email` -- or any field this endpoint does not own -- is a 422, never a
 * silent no-op that would let a client believe the email changed. Changing
 * the email would require verifying the new address again, which is not
 * part of this phase.
 */
export const updateCustomerProfileRequestSchema = z
  .object({
    fullName: z.string().min(3).max(120).optional(),
    phone: z.string().min(7).max(30).optional(),
  })
  .strict();

export type CustomerProfileContract = z.infer<typeof customerProfileSchema>;
export type UpdateCustomerProfileRequest = z.infer<typeof updateCustomerProfileRequestSchema>;
