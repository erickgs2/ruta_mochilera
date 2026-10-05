import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { config as getConfig } from './lib/config';
import { corsPreflightResponse } from './lib/http/cors';

/**
 * Answers the CORS preflight (`OPTIONS`) a browser/WebView sends ahead of a
 * credentialed, non-safelisted cross-origin request -- see
 * `apps/api/src/lib/http/cors.ts` for why this exists at all (Task 15 found
 * the API answered no preflight whatsoever, which blocked a packaged
 * Capacitor app from reaching `/auth/login`).
 *
 * Every *actual* request's response (success or failure) already gets its
 * CORS headers from `route()` (see `lib/http/route.ts`) -- that is a plain
 * function every JSON route.ts already calls, so it is covered by the normal
 * Vitest suite. (The two raw handlers that bypass `route()`,
 * `openapi.json` and `files/[...key]`, get no CORS headers: neither is
 * something the packaged app fetches with credentials -- an `<img>` needs
 * no CORS.) `OPTIONS` is different: no route.ts exports it, so Next.js
 * would otherwise answer it itself -- a bare `204` with an `Allow` header
 * and no CORS headers, i.e. a failed preflight -- before `route()` ever
 * runs. Proxy (the file convention Next.js 16 renamed from
 * `middleware.ts`; see `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/proxy.md`) is the one layer that runs ahead of routing
 * and can intercept `OPTIONS` directly.
 *
 * `corsPreflightResponse` returns `null` for anything that is not a
 * same-origin-irrelevant, allowlisted preflight -- not `OPTIONS`, no
 * `Origin`, or an `Origin` outside `corsAllowedOrigins`. In every one of
 * those cases this falls through to `NextResponse.next()`, i.e. exactly
 * whatever Next.js already does today. The admin panel and the web client
 * never send a preflight at all (they are same-origin through Nginx), so
 * this file changes nothing for them.
 */
export function proxy(request: NextRequest): Response {
  const preflight = corsPreflightResponse(request, getConfig().corsAllowedOrigins);
  return preflight ?? NextResponse.next();
}

/** Only `/api/v1/**` can ever carry a cross-origin preflight this API cares about -- never the Next.js internals or any non-API path. */
export const config = {
  matcher: '/api/v1/:path*',
};
