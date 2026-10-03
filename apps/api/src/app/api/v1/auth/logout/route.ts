import { logout } from '@rm/domain-identity';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { clearRefreshCookieHeader, readRefreshCookie } from '../../../../../lib/http/refresh-cookie';

/**
 * No request body: the refresh token to revoke is read from the cookie, same
 * as `/auth/refresh`. Closing an already-closed session (no cookie, or a
 * cookie the server no longer recognises) is still a success -- `logout()`
 * itself never fails -- and the cookie is always cleared in the response so
 * the browser stops sending a token the server has revoked.
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
    const refreshToken = readRefreshCookie(request);
    return refreshToken ? logout(db(), { refreshToken }) : ok(null);
  },
});
