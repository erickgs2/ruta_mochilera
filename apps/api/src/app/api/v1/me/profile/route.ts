import { updateCustomerProfileRequestSchema, type UpdateCustomerProfileRequest } from '@rm/contracts';
import { getCustomerProfile, updateCustomerProfile } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { storage } from '../../../../../lib/storage';

/**
 * The authenticated customer's own profile. There is no id in the path: these
 * endpoints always act on the caller, so ownership holds by construction and
 * there is no permission to check. A staff user has no customer profile and
 * gets `NOT_FOUND`.
 */
export const GET = route({
  handler: async ({ actor }) => getCustomerProfile(db(), storage(), actor.userId),
});

/** Name and phone only -- the schema is `.strict()`, so an `email` is refused with 422. */
export const PATCH = route<UpdateCustomerProfileRequest, unknown>({
  body: updateCustomerProfileRequestSchema,
  handler: async ({ actor, body }) =>
    updateCustomerProfile(db(), storage(), actor.userId, { fullName: body.fullName, phone: body.phone }),
});
