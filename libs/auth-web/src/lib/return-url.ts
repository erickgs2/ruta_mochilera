/** Query parameter that carries "where the visitor was going" through the auth screens. */
export const RETURN_URL_PARAM = 'returnUrl';

/**
 * Validates a `returnUrl` read from an address bar. Only same-app relative
 * paths pass (`/trips/x/reserve?y=1`); anything else comes back `null` so the
 * caller falls back to its default. This is the open-redirect guard: the
 * value is attacker-controllable (anyone can craft a `/login?returnUrl=…`
 * link), so an absolute URL, a protocol-relative `//host`, or a backslash
 * variant browsers normalise into one must never be navigated to. Inside
 * the app those would only fail to match a route, but dot segments (`..`,
 * also written `%2e%2e`) and an `@` in the first segment (`/@evil.com`, the
 * userinfo shape) are refused as well, so a later change to how the value is
 * used cannot turn them into a way out.
 */
export function parseReturnUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048)
    return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  for (const char of value) {
    const code = char.charCodeAt(0);
    // Backslash and control characters (tab, newline, …) are stripped or
    // rewritten by URL parsers, so `/\evil.com` and `/<TAB>/evil.com` would
    // otherwise turn into `//evil.com`.
    if (char === '\\' || code <= 0x1f || code === 0x7f) return null;
  }
  const segments = value.split(/[?#]/, 1)[0].split('/').slice(1);
  if (segments.some((segment) => /^(\.|%2e){2}$/i.test(segment))) return null;
  if (/@|%40/i.test(segments[0])) return null;
  return value;
}
