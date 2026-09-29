import { loginRequestSchema, type LoginRequest } from '@rm/contracts';
import { login } from '@rm/domain-identity';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

export const POST = route<LoginRequest, unknown>({
  auth: 'public',
  body: loginRequestSchema,
  handler: async ({ body, request }) =>
    login(db(), config(), {
      email: body.email,
      password: body.password,
      deviceId: body.deviceId,
      userAgent: request.headers.get('user-agent') ?? undefined,
    }),
});
