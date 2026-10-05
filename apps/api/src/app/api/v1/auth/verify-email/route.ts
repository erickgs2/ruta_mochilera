import { verifyEmailRequestSchema, type VerifyEmailRequest } from '@rm/contracts';
import { verifyEmail } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { clientIp } from '../../../../../lib/http/client-ip';
import { route } from '../../../../../lib/http/route';

export const POST = route<VerifyEmailRequest, null>({
  auth: 'public',
  body: verifyEmailRequestSchema,
  handler: async ({ body, request }) =>
    verifyEmail(db(), { email: body.email, code: body.code }, clientIp(request)),
});
