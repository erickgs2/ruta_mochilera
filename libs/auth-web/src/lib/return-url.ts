/** Query parameter that carries "where the visitor was going" through the auth screens. */
export const RETURN_URL_PARAM = 'returnUrl';

/**
 * Validates a `returnUrl` read from an address bar. Only same-app relative
 * paths pass (`/trips/x/reserve?y=1`); anything else comes back `null` so the
 * caller falls back to its default. This is the open-redirect guard: the
 * value is attacker-controllable (anyone can craft a `/login?returnUrl=…`
 * link), so an absolute URL, a protocol-relative `//host`, or a backslash
 * variant browsers normalise into one must never be navigated to.
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
  return value;
}
