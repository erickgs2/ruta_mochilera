import { resetPasswordRequestSchema, type ResetPasswordRequest } from '@rm/contracts';
import { resetPassword } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/** No rate limiting here, deliberately: the brief lists only `register`, `verify-email`, `resend-code` and `forgot-password` among the throttled endpoints. The token itself is a 256-bit random value delivered through a one-time link, not a guessable secret the way a six-digit OTP or a password is. */
export const POST = route<ResetPasswordRequest, null>({
  auth: 'public',
  body: resetPasswordRequestSchema,
  handler: async ({ body }) => resetPassword(db(), body.token, body.newPassword),
});
