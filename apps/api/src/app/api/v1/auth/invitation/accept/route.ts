import { acceptInvitationRequestSchema, type AcceptInvitationRequest } from '@rm/contracts';
import { acceptInvitation } from '@rm/domain-identity';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/**
 * A counter customer activates their account from the invitation link:
 * chooses a password and accepts the terms. Public -- the token is the
 * credential. Answers the account's email so the app can prefill the login.
 */
export const POST = route<AcceptInvitationRequest, unknown>({
  auth: 'public',
  body: acceptInvitationRequestSchema,
  handler: async ({ body }) => acceptInvitation(db(), { token: body.token, password: body.password }),
});
