import { loginRequestSchema, type LoginRequest } from '@rm/contracts';
import { login, type AuthenticatedUser, type SessionTokens } from '@rm/domain-identity';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { clientIp } from '../../../../../lib/http/client-ip';
import { route } from '../../../../../lib/http/route';
import { clientPlatform, sessionResponse } from '../../../../../lib/http/refresh-cookie';

export const POST = route<LoginRequest, { user: AuthenticatedUser; tokens: SessionTokens }>({
  auth: 'public',
  body: loginRequestSchema,
  // See `sessionResponse`: for a web caller (the default) the refresh token
  // never reaches the JSON body, it travels as an httpOnly cookie instead.
  // `clientPlatform` only ever says otherwise for the packaged app, which
  // sets `X-Client-Platform: native` deliberately (see `@rm/auth-web`).
  respond: (result, request) => sessionResponse(result, config().refreshTokenTtlDays, clientPlatform(request)),
  handler: async ({ body, request }) =>
    login(db(), config(), {
      email: body.email,
      password: body.password,
      deviceId: body.deviceId,
      userAgent: request.headers.get('user-agent') ?? undefined,
      ip: clientIp(request),
    }),
});
