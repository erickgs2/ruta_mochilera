import { refreshSession, type AuthenticatedUser, type SessionTokens } from '@rm/domain-identity';
import { fail } from '@rm/shared-utils';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { readRefreshCookie, sessionResponse } from '../../../../../lib/http/refresh-cookie';

/**
 * No request body: the refresh token travels only as the httpOnly cookie
 * `/auth/login` set, never in JSON (see `refresh-cookie.ts`). A caller with
 * no cookie at all gets the same `TOKEN_INVALID` a stale or forged token
 * would, without ever reaching the domain service.
 */
export const POST = route<undefined, { user: AuthenticatedUser; tokens: SessionTokens }>({
  auth: 'public',
  respond: (result) => sessionResponse(result, config().refreshTokenTtlDays),
  handler: async ({ request }) => {
    const refreshToken = readRefreshCookie(request);
    if (!refreshToken) return fail('TOKEN_INVALID');
    return refreshSession(db(), config(), {
      refreshToken,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
  },
});
