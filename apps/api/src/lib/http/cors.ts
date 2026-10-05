/**
 * CORS for the few callers that are genuinely cross-origin: today, that is
 * only the packaged Capacitor app (`capacitor://localhost` on iOS,
 * `https://localhost` on Android by default -- see
 * `apps/client/capacitor.config.ts`). The admin panel and the web client
 * share an origin with this API through Nginx (see
 * `infra/nginx/nginx.conf.template`) and have never needed CORS at all; this
 * module must never add a header to a request that does not carry a
 * matching `Origin`, or that same-origin path would be the one thing this
 * file could regress.
 *
 * See `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`
 * for the empirical finding that led here: `curl -X OPTIONS` against the
 * live API carried no `Access-Control-Allow-Origin` header at all, so a
 * packaged app could not even reach `/auth/login`.
 */

/** Exact match only -- never a prefix, a suffix, or (see the test suite) a wildcard entry in the allowlist itself. */
export function isAllowedOrigin(origin: string | null, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin) && origin !== '*';
}

/**
 * Adds the CORS response headers when (and only when) `request`'s `Origin`
 * matches `allowedOrigins`. Otherwise returns `response` completely
 * untouched -- this is what keeps the same-origin admin/web path byte-for-
 * byte identical to today.
 *
 * `Access-Control-Allow-Credentials: true` is always paired with the exact
 * echoed origin, never `*`: the Fetch spec itself forbids combining
 * wildcard-origin with credentialed responses, and echoing the one origin
 * that was actually asked for is what lets the browser's cache vary
 * correctly (`Vary: Origin`) across multiple allowed callers.
 */
export function applyCorsHeaders(response: Response, request: Request, allowedOrigins: readonly string[]): Response {
  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin, allowedOrigins)) return response;
  response.headers.set('Access-Control-Allow-Origin', origin as string);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  // `append`, not `set`: a route that already varies on something else
  // (e.g. `Accept-Encoding`) must keep it.
  response.headers.append('Vary', 'Origin');
  return response;
}

/**
 * Headers this API accepts on a cross-origin request: the bearer token,
 * JSON bodies, and the two headers the native transport uses instead of a
 * cookie (see `refresh-cookie.ts`'s `clientPlatform` and `readRefreshToken`).
 */
const ALLOWED_REQUEST_HEADERS = ['content-type', 'authorization', 'x-client-platform', 'x-refresh-token'];
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
/** 24 hours -- preflight results are cheap to cache and this allowlist changes only at deploy time. */
const PREFLIGHT_MAX_AGE_SECONDS = 60 * 60 * 24;

/**
 * Builds the preflight (`OPTIONS`) response for a matching cross-origin
 * request, or `null` when this request is not a CORS preflight this module
 * should answer -- not `OPTIONS`, no `Origin` header, or an `Origin` outside
 * the allowlist. `null` means "let it fall through to whatever Next.js does
 * today": no route exports `OPTIONS`, so Next.js answers it itself with a
 * bare `204` and an `Allow` header and no CORS headers at all (observed with
 * `curl -X OPTIONS` against `nx dev api`), which a browser treats as a
 * failed preflight. That is exactly unchanged behaviour for every caller
 * other than an allowed cross-origin one.
 */
export function corsPreflightResponse(request: Request, allowedOrigins: readonly string[]): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin, allowedOrigins)) return null;

  const response = new Response(null, { status: 204 });
  response.headers.set('Access-Control-Allow-Origin', origin as string);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
  response.headers.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS.join(', '));
  response.headers.set('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
  response.headers.set('Vary', 'Origin');
  return response;
}
