import { forgotPasswordRequestSchema, type ForgotPasswordRequest } from '@rm/contracts';
import { requestPasswordReset } from '@rm/domain-identity';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { email } from '../../../../../lib/email';
import { clientIp } from '../../../../../lib/http/client-ip';
import { route } from '../../../../../lib/http/route';

/**
 * Always responds `ok(null)` whether or not `body.email` has an account --
 * see `requestPasswordReset`'s doc comment in `@rm/domain-identity` for how
 * the response time is kept comparable between the two cases too (not just
 * the body).
 */
export const POST = route<ForgotPasswordRequest, null>({
  auth: 'public',
  body: forgotPasswordRequestSchema,
  handler: async ({ body, request }) =>
    requestPasswordReset(db(), body.email, email(), config().clientAppUrl, clientIp(request)),
});
