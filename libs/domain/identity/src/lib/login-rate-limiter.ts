/**
 * Login attempt limiting (spec §10: "Límite de intentos en login, verificación
 * OTP y recuperación de contraseña"). Phase 1 runs a single API instance (one
 * `apps/api` container per environment, see `infra/compose/compose.prod.yml`)
 * so an in-memory counter is sufficient; it does not survive a restart or
 * generalise to multiple instances, and a later phase that needs either
 * should move this to a shared store (Postgres or Redis) without changing the
 * call sites below.
 *
 * Two independent counters, not one combined key, because they catch two
 * different attacks: many passwords tried against one email (brute force --
 * caught by the email counter even if the attacker rotates IPs) and one IP
 * trying many emails (credential stuffing -- caught by the IP counter even
 * though each individual email sees only one attempt). Either counter tripping
 * blocks the request.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Bucket {
  count: number;
  windowStart: number;
}

const byEmail = new Map<string, Bucket>();
const byIp = new Map<string, Bucket>();

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
 * logins inside the current window. Callers must check this *before* doing
 * any password verification work -- see `login()` in `./auth-service.ts`,
 * which checks it ahead of even the dummy-hash timing defence, so a
 * rate-limited burst spends no argon2 time at all.
 */
export function isLoginRateLimited(email: string, ip: string, now: number = Date.now()): boolean {
  return limited(byEmail, email, now) || limited(byIp, ip, now);
}

/** Records one failed attempt against both counters. */
export function recordFailedLoginAttempt(email: string, ip: string, now: number = Date.now()): void {
  recordFailure(byEmail, email, now);
  recordFailure(byIp, ip, now);
}

/** Clears both counters on a successful login, so a legitimate user is never penalised for an attacker's earlier misses once they do get in. */
export function clearLoginRateLimit(email: string, ip: string): void {
  byEmail.delete(email);
  byIp.delete(ip);
}

/** Test-only seam: resets all state between specs, mirroring `setConfig`/`setDb` elsewhere in the codebase. */
export function resetLoginRateLimiterForTesting(): void {
  byEmail.clear();
  byIp.clear();
}
