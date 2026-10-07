import { z } from 'zod';

/** What receipts print about the agency (Phase 2B, §4.6): `GET`/`PUT /api/v1/admin/settings/organization`. */
export const organizationProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(300),
  phone: z.string().trim().max(120),
  website: z.string().trim().max(200),
});

export type OrganizationProfileContract = z.infer<typeof organizationProfileSchema>;
