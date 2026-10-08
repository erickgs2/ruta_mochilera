import { updateMeRequestSchema, type UpdateMeRequest } from '@rm/contracts';
import { describeUser, updateOwnLocale } from '@rm/domain-identity';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

export const GET = route({
  handler: async ({ actor }) => ok(await describeUser(db(), actor.userId)),
});

/**
 * The caller's own language, for staff and customers alike. No id in the path
 * and no permission: it always acts on `actor.userId`, so ownership holds by
 * construction. Responds with the user as a session describes them; the next
 * token refresh carries the same locale.
 */
export const PATCH = route<UpdateMeRequest, unknown>({
  body: updateMeRequestSchema,
  handler: async ({ actor, body }) => updateOwnLocale(db(), actor.userId, body.locale),
});
