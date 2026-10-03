/**
 * Best-effort client IP for login rate limiting. Next.js route handlers never
 * expose the raw socket address, so this trusts the reverse proxy's headers
 * instead -- `infra/nginx/nginx.conf.template` sets both `X-Forwarded-For` and
 * `X-Real-IP` on every request it proxies to the API container. Falls back to
 * a constant (never `undefined`) so every anonymous caller with no proxy in
 * front of it (local dev without Nginx, for instance) still shares one
 * bucket rather than bypassing the limiter entirely.
 */
export function clientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}
