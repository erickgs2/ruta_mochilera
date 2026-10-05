/**
 * Attempt limiting for every public, unauthenticated endpoint (spec §10:
 * "Límite de intentos en login, verificación OTP y recuperación de
 * contraseña"). Originally written for `/auth/login` alone (as
 * `login-rate-limiter.ts`); Phase 2A opens four more public endpoints
 * (`register`, `verify-email`, `resend-code`, `forgot-password`) that need
 * the exact same brute-force defence, so this module was generalised rather
 * than duplicated -- every call site now names its own `scope` instead of
 * there being a second, near-identical limiter living next to this one.
 *
 * Phase 1 runs a single API instance (one `apps/api` container per
 * environment, see `infra/compose/compose.prod.yml`), so an in-memory
 * counter is sufficient *today*: it is per-process, which means (a) it does
 * not survive a restart and (b) it does not hold across multiple API
 * instances, since each process would keep its own counters. Both are
 * acceptable for a single-instance deployment but would silently stop
 * working the moment this API is scaled horizontally. A later phase that
 * needs either property should move this to a shared store (Postgres or
 * Redis) without changing the call sites below -- the exported surface
 * (`isRateLimited` / `recordFailedAttempt` / `clearRateLimit`) is already
 * shaped so that swap would be internal to this file.
 *
 * Two independent counters per scope, not one combined key, because they
 * catch two different attacks: many values tried against one email (brute
 * force -- caught by the email counter even if the attacker rotates IPs)
 * and one IP trying many emails (credential stuffing / enumeration --
 * caught by the IP counter even though each individual email sees only one
 * attempt). Either counter tripping blocks the request.
 */

/** Every public endpoint this limiter is asked to protect. Each gets its own pair of counters. */
export type RateLimitScope = 'login' | 'register' | 'verify-email' | 'resend-code' | 'forgot-password';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Bucket {
  count: number;
  windowStart: number;
}

const byEmail = new Map<string, Bucket>();
const byIp = new Map<string, Bucket>();

/** Namespaces a raw email/IP key by scope, so `register` and `login` never share a bucket. */
function scopedKey(scope: RateLimitScope, key: string): string {
  return `${scope}:${key}`;
}

function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart >= WINDOW_MS;
}

function limited(store: Map<string, Bucket>, key: string, now: number): boolean {
  const bucket = store.get(key);
  if (!bucket || isExpired(bucket, now)) return false;
  return bucket.count >= MAX_ATTEMPTS;
}

function recordFailure(store: Map<string, Bucket>, key: string, now: number): void {
  const bucket = store.get(key);
  if (!bucket || isExpired(bucket, now)) {
    store.set(key, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/**
 * True when either the email or the IP has already hit `MAX_ATTEMPTS` failed
 * attempts against `scope` inside the current window. Callers must check
 * this *before* doing any expensive verification work -- see `login()` in
 * `./auth-service.ts`, which checks it ahead of even the dummy-hash timing
 * defence, so a rate-limited burst spends no argon2 time at all.
 */
export function isRateLimited(
  scope: RateLimitScope,
  email: string,
  ip: string,
  now: number = Date.now()
): boolean {
  return limited(byEmail, scopedKey(scope, email), now) || limited(byIp, scopedKey(scope, ip), now);
}

/** Records one failed attempt against `scope`'s email and IP counters. */
export function recordFailedAttempt(scope: RateLimitScope, email: string, ip: string, now: number = Date.now()): void {
  recordFailure(byEmail, scopedKey(scope, email), now);
  recordFailure(byIp, scopedKey(scope, ip), now);
}

/** Clears both of `scope`'s counters on success, so a legitimate caller is never penalised for an attacker's earlier misses once they do get through. */
export function clearRateLimit(scope: RateLimitScope, email: string, ip: string): void {
  byEmail.delete(scopedKey(scope, email));
  byIp.delete(scopedKey(scope, ip));
}

/** Test-only seam: resets all state (every scope) between specs, mirroring `setConfig`/`setDb` elsewhere in the codebase. */
export function resetRateLimiterForTesting(): void {
  byEmail.clear();
  byIp.clear();
}
