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
 * Shared `respond` override for `/auth/login` and `/auth/refresh`: both issue
 * a session and must deliver it the same way. The JSON body never carries
 * `refreshToken` -- only `accessToken` and `expiresInSeconds` -- and the
 * refresh token instead rides the `Set-Cookie` header built above.
 *
 * On failure, the cookie is cleared rather than left alone: a refresh that
 * came back `TOKEN_REUSED` or `TOKEN_INVALID` means the token the browser is
 * holding is dead, so there is no reason to let it keep sending it.
 */
export function sessionResponse(result: Result<SessionResult>, refreshTokenTtlDays: number): Response {
  if (!result.ok) {
    const response = problemResponse(result.error);
    response.headers.append('set-cookie', clearRefreshCookieHeader());
    return response;
  }
  const { user, tokens } = result.value;
  const response = Response.json(
    { user, tokens: { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds } },
    { status: 200 }
  );
  response.headers.append('set-cookie', setRefreshCookieHeader(tokens.refreshToken, refreshTokenTtlDays));
  return response;
}
