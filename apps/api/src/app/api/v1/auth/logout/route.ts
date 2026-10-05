import { logout } from '@rm/domain-identity';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { clearRefreshCookieHeader, readRefreshToken } from '../../../../../lib/http/refresh-cookie';

/**
 * The token to revoke is read from the cookie for a web caller, same as
 * `/auth/refresh` -- or from the `X-Refresh-Token` header for a native
 * caller, since its cookie never survived in the first place (see
 * `readRefreshToken`). Closing an already-closed session (neither present,
 * or a token the server no longer recognises) is still a success --
 * `logout()` itself never fails -- and the cookie is always cleared in the
 * response so a web browser stops sending a token the server has revoked;
 * clearing a cookie the native caller never had is a harmless no-op for it.
 */
export const POST = route<undefined, null>({
  auth: 'public',
  successStatus: 204,
  respond: () => {
    const response = new Response(null, { status: 204 });
    response.headers.append('set-cookie', clearRefreshCookieHeader());
    return response;
  },
  handler: async ({ request }) => {
    const refreshToken = readRefreshToken(request);
    return refreshToken ? logout(db(), { refreshToken }) : ok(null);
  },
});
