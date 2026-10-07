import type { Result } from '@rm/shared-utils';
import { problemResponse } from './problem';

/**
 * Transports the refresh token between the API and the Angular panel. Never
 * read by client-side script: see the spec's security section
 * (`docs/superpowers/specs/2026-09-28-agencia-viajes-diseno.md`, §10) --
 * `httpOnly`, `Secure`, `SameSite=Strict`.
 */
const REFRESH_COOKIE_NAME = 'rm_refresh_token';

/**
 * Scopes the cookie to the two endpoints that ever read it. The browser
 * never attaches it to `/api/v1/trips`, `/api/v1/staff`, etc. -- there is no
 * reason those requests should carry a long-lived credential at all, and
 * narrowing the path shrinks what a request-smuggling or logging mistake on
 * an unrelated endpoint could ever expose.
 */
const COOKIE_PATH = '/api/v1/auth';

function attributes(maxAgeSeconds: number): string {
  // `SameSite=Strict` (not `Lax`): the panel and the API share an origin
  // through Nginx (see `infra/nginx/nginx.conf.template`), so there is no legitimate
  // top-level cross-site navigation that ever needs this cookie attached.
  // `Secure` requires HTTPS in production -- see the deployment section of
  // the README for how this host terminates TLS.
  return [`Path=${COOKIE_PATH}`, 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`].join('; ');
}

/** Builds the `Set-Cookie` header value that hands a fresh refresh token to the browser. */
export function setRefreshCookieHeader(token: string, ttlDays: number): string {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes(ttlDays * 24 * 60 * 60)}`;
}

/** Builds the `Set-Cookie` header value that deletes the cookie (logout, or a refresh that failed). */
export function clearRefreshCookieHeader(): string {
  return `${REFRESH_COOKIE_NAME}=; ${attributes(0)}`;
}

/** Reads the refresh token the browser attached, or `undefined` when there is none. */
export function readRefreshCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === REFRESH_COOKIE_NAME) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export interface SessionResult {
  user: unknown;
  tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number };
}

/**
 * Which refresh-token transport a caller gets. `'web'` -- the only thing
 * this API has ever done -- is the default for anything the header below
 * does not spell out exactly, so an absent header, a malformed one, or a
 * caller that predates this header all keep today's cookie-only behaviour
 * byte-for-byte. `'native'` exists only because Task 15 found the httpOnly
 * cookie does not survive inside a packaged Capacitor app (cross-origin,
 * `SameSite=Strict` forbids attaching it): see
 * `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`.
 * The packaged app's own HTTP layer sets this header deliberately (see
 * `@rm/auth-web`'s `RefreshTokenStore`); nothing a browser page does can
 * produce it by accident.
 */
export type ClientPlatform = 'web' | 'native';

const CLIENT_PLATFORM_HEADER = 'x-client-platform';

/** Fails closed to `'web'`: only the exact literal `'native'` ever changes behaviour. */
export function clientPlatform(request: Request): ClientPlatform {
  return request.headers.get(CLIENT_PLATFORM_HEADER) === 'native' ? 'native' : 'web';
}

/**
 * The transport `/auth/refresh` answers on. Unlike `/auth/login` (where
 * `clientPlatform` alone decides), a refresh that presented the
 * `rm_refresh_token` cookie is a browser session by definition, and always
 * answers `'web'` -- rotating the cookie, never the JSON body -- whatever
 * `X-Client-Platform` claims.
 *
 * Why the claim alone is not enough here: a same-origin script can set that
 * header too. An XSS payload on the admin panel could POST `/auth/refresh`
 * with `X-Client-Platform: native`, the browser would still attach the
 * httpOnly cookie, and if the header decided the transport the rotated
 * refresh token would come back in a body that script can read -- turning
 * the one thing the httpOnly cookie protects into something XSS can steal.
 * A native caller never has the cookie in the first place (it is never set
 * for one, and would not survive the WebView's cross-origin jar if it were),
 * so this costs the packaged app nothing.
 */
export function refreshTransport(request: Request): ClientPlatform {
  return readRefreshCookie(request) ? 'web' : clientPlatform(request);
}

const REFRESH_TOKEN_HEADER = 'x-refresh-token';

/**
 * Reads the refresh token for `/auth/refresh` and `/auth/logout`: the
 * `rm_refresh_token` cookie first (the only thing a web caller can ever
 * produce), falling back to the `X-Refresh-Token` header when there is no
 * cookie. That fallback is what lets the native transport work at all --
 * its cookie, even if the server still sets one, never survives the
 * WebView's cross-origin `SameSite=Strict` jar (Task 15), so it has nothing
 * to attach automatically and must send the token itself.
 *
 * A header, not a JSON body field: `X-Refresh-Token` is not one of the
 * Fetch spec's CORS-safelisted header names, so a browser or WebView
 * refuses to send it cross-origin without a real preflight first -- the
 * same protection `parseBody`'s `Content-Type` check gives `/auth/login`
 * (see `route.ts`), reached a simpler way here since this path never needs
 * to parse a body at all. This never changes what a web caller can do: a
 * web session that still has its cookie never reaches this fallback.
 */
export function readRefreshToken(request: Request): string | undefined {
  const cookie = readRefreshCookie(request);
  if (cookie) return cookie;
  const header = request.headers.get(REFRESH_TOKEN_HEADER)?.trim();
  return header && header.length > 0 ? header : undefined;
}

/**
 * Shared `respond` override for `/auth/login` and `/auth/refresh`: both issue
 * a session and must deliver it the same way, which now branches on
 * `platform` (default `'web'`, so any call site that does not pass it keeps
 * exactly today's behaviour):
 *
 * - `'web'`: unchanged from before this file knew about platforms at all.
 *   The JSON body never carries `refreshToken` -- only `accessToken` and
 *   `expiresInSeconds` -- and the refresh token instead rides the
 *   `Set-Cookie` header built above. A token a script on the page can read
 *   is a token XSS can steal; that property is exactly what this branch
 *   preserves.
 * - `'native'`: the JSON body *does* carry `refreshToken`, and no cookie is
 *   set at all (there is no reason to set one that cannot survive the
 *   WebView's cookie jar -- see `readRefreshToken` above). The one reader of
 *   this field is the single call site in `@rm/auth-web`'s native
 *   `RefreshTokenStore` that immediately hands it to Keychain/Keystore; nothing
 *   else in the native app's JS is meant to touch it.
 *
 * On failure, `'web'` clears the cookie rather than leaving it alone: a
 * refresh that came back `TOKEN_REUSED` or `TOKEN_INVALID` means the token
 * the browser is holding is dead, so there is no reason to let it keep
 * sending it. `'native'` has no cookie to clear.
 */
export function sessionResponse(
  result: Result<SessionResult>,
  refreshTokenTtlDays: number,
  platform: ClientPlatform = 'web'
): Response {
  if (!result.ok) {
    const response = problemResponse(result.error);
    if (platform === 'web') response.headers.append('set-cookie', clearRefreshCookieHeader());
    return response;
  }
  const { user, tokens } = result.value;
  const body: { user: unknown; tokens: { accessToken: string; expiresInSeconds: number; refreshToken?: string } } = {
    user,
    tokens: { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds },
  };
  if (platform === 'native') body.tokens.refreshToken = tokens.refreshToken;
  const response = Response.json(body, { status: 200 });
  if (platform === 'web') response.headers.append('set-cookie', setRefreshCookieHeader(tokens.refreshToken, refreshTokenTtlDays));
  return response;
}
