import { refreshSession, type AuthenticatedUser, type SessionTokens } from '@rm/domain-identity';
import { fail } from '@rm/shared-utils';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { readRefreshToken, refreshTransport, sessionResponse } from '../../../../../lib/http/refresh-cookie';

/**
 * No request body: for a web caller, the refresh token travels only as the
 * httpOnly cookie `/auth/login` set (see `refresh-cookie.ts`). A native
 * caller has no such cookie (Task 15: it does not survive the WebView's
 * cross-origin `SameSite=Strict` jar) and sends the token it read out of
 * secure storage as the `X-Refresh-Token` header instead --
 * `readRefreshToken` tries the cookie first and only falls back to that
 * header when there is none. A caller with neither gets the same
 * `TOKEN_INVALID` a stale or forged token would, without ever reaching the
 * domain service.
 *
 * The response's transport comes from `refreshTransport`, not the
 * `X-Client-Platform` header alone: a refresh the cookie authenticated
 * always rotates the cookie and never puts the new token in the body, so a
 * same-origin script cannot use the header to read a browser session's
 * refresh token (see that function's doc comment).
 */
export const POST = route<undefined, { user: AuthenticatedUser; tokens: SessionTokens }>({
  auth: 'public',
  respond: (result, request) => sessionResponse(result, config().refreshTokenTtlDays, refreshTransport(request)),
  handler: async ({ request }) => {
    const refreshToken = readRefreshToken(request);
    if (!refreshToken) return fail('TOKEN_INVALID');
    return refreshSession(db(), config(), {
      refreshToken,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
  },
});
