import { socialLoginRequestSchema, type SocialLoginRequest } from '@rm/contracts';
import { loginWithProvider, type AuthenticatedUser, type SessionTokens } from '@rm/domain-identity';
import { config } from '../../../../../../lib/config';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { sessionResponse } from '../../../../../../lib/http/refresh-cookie';

/**
 * Sign in (or sign up) with a Google id token. Answers `PROVIDER_DISABLED`
 * (503), never a 500, when `GOOGLE_OAUTH_CLIENT_ID` is unconfigured -- see
 * `loginWithProvider` in `@rm/domain-identity`. Like `/auth/login`, the
 * refresh token travels only as the httpOnly `rm_refresh_token` cookie, never
 * in this JSON body.
 */
export const POST = route<SocialLoginRequest, { user: AuthenticatedUser; tokens: SessionTokens }>({
  auth: 'public',
  body: socialLoginRequestSchema,
  respond: (result) => sessionResponse(result, config().refreshTokenTtlDays),
  handler: async ({ body, request }) =>
    loginWithProvider(db(), config(), {
      provider: 'GOOGLE',
      idToken: body.idToken,
      deviceId: body.deviceId,
      userAgent: request.headers.get('user-agent') ?? undefined,
    }),
});
