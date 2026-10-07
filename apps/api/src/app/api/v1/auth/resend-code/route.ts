import { resendCodeRequestSchema, type ResendCodeRequest } from '@rm/contracts';
import { resendVerificationCode } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { email } from '../../../../../lib/email';
import { clientIp } from '../../../../../lib/http/client-ip';
import { route } from '../../../../../lib/http/route';

export const POST = route<ResendCodeRequest, null>({
  auth: 'public',
  body: resendCodeRequestSchema,
  handler: async ({ body, request }) => resendVerificationCode(db(), email(), body.email, clientIp(request)),
});
