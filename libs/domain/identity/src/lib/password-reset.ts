import { createHash, randomBytes } from 'node:crypto';
import type { Db, DbTransactionClient } from '@rm/db';
import type { EmailProvider } from '@rm/email';
import { fail, ok, type Result } from '@rm/shared-utils';
import { hashPassword } from './password';
import { isRateLimited, recordFailedAttempt } from './rate-limiter';

/** Opaque reset token. Only its SHA-256 hash is ever persisted -- same shape as `generateRefreshToken` in `./tokens.ts`. */
function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The brief gives no exact minute value for this setting (unlike Task 11's four OTP settings) -- see `libs/db/prisma/seed.ts`'s comment on the same key for why 60 was chosen. */
const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 60;

async function loadPasswordResetTtlMinutes(db: Db): Promise<number> {
  const setting = await db.systemSetting.findUnique({ where: { key: 'password_reset.ttl_minutes' } });
  return typeof setting?.value === 'number' ? setting.value : DEFAULT_PASSWORD_RESET_TTL_MINUTES;
}

/**
 * `clientAppUrl` is the client app's public base URL (`CLIENT_APP_URL`),
 * path prefix included, injected by the caller rather than hardcoded, so
 * staging, a local run and production each mail a link to their own client
 * app. Not `APP_BASE_URL`: that is the API's origin, where `/reset-password`
 * does not exist.
 */
function buildResetEmail(token: string, clientAppUrl: string): { subject: string; html: string; text: string } {
  const link = `${clientAppUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
  const text =
    `Para restablecer tu contraseña, usa este enlace: ${link} ` +
    'Si no lo solicitaste, ignora este correo; tu contraseña actual sigue funcionando.';
  return { subject: 'Restablece tu contraseña', html: `<p>${text}</p>`, text };
}

/**
 * Requests a password reset email. **Never reveals whether `email` belongs
 * to an account** -- same decision Phase 1 already made for `login`
 * (`INVALID_CREDENTIALS` either way) and the same one `registerCustomer`
 * makes for its own duplicate-email case. This is the brief's own example of
 * the pattern ("mismo código, mismo cuerpo, y tiempos comparables -- el
 * camino de cuenta inexistente debe hacer trabajo equivalente, igual que el
 * hash señuelo que la Fase 1 añadió al login"), and explicitly the easiest
 * one to break by accident (a well-meaning "friendlier" screen for the
 * missing-account case).
 *
 * How the timing symmetry is actually closed: `login`'s defence works by
 * making the *fast* path (unknown email) pay the same *slow* cost (argon2)
 * as the real one. That trick does not transfer here, because the
 * expensive step in this flow is not CPU-bound -- it is the outbound
 * network call to the email provider, whose latency this code cannot
 * manufacture on the "no account" branch (there is no mailbox to reach, and
 * even calling the provider with a bogus address would surface the
 * asymmetry the moment the provider swaps or its latency profile changes).
 * Instead, the send is simply **never awaited on the request path** --
 * `void emailProvider.send(...)` fires it and returns immediately -- for
 * the one branch that has a real recipient. With the dominant cost removed
 * from both branches' critical path, the only remaining difference is one
 * `PasswordReset` INSERT, which is small, bounded, and already covered by
 * this module's own timing test.
 *
 * Not awaiting also means this call never passes the plaintext token
 * through the Task 8 pg-boss outbox (`SEND_NOTIFICATION_EMAIL_JOB`), which
 * durably persists its payload in Postgres until a worker consumes it --
 * exactly the kind of transient clear-text storage "stored hashed, never in
 * clear" is meant to forbid. A fire-and-forget in-process call keeps the
 * plaintext token confined to this one function's stack and the
 * recipient's inbox.
 */
export async function requestPasswordReset(
  db: Db,
  rawEmail: string,
  emailProvider: EmailProvider,
  clientAppUrl: string,
  ip = 'unknown'
): Promise<Result<null>> {
  const email = rawEmail.trim().toLowerCase();

  if (isRateLimited('forgot-password', email, ip)) return fail('RATE_LIMITED');
  recordFailedAttempt('forgot-password', email, ip);

  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  const ttlMinutes = await loadPasswordResetTtlMinutes(db);
  const { token, tokenHash } = generateResetToken();

  if (user) {
    await db.passwordReset.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + ttlMinutes * 60_000) },
    });
    // Fire-and-forget: see the doc comment above for why this call is
    // deliberately not awaited.
    void emailProvider.send({ to: user.email, ...buildResetEmail(token, clientAppUrl) }).catch(() => {
      // A provider failure here must never surface to the caller -- doing
      // so would itself be an enumeration signal (a visible delay or error
      // only on the branch that has a real recipient). The worst outcome is
      // a customer who never receives the email and tries again later,
      // which `resend`-style throttling elsewhere in this phase already
      // tolerates.
    });
  }
  // No `else` branch: there is no mailbox to reach, and (per the doc
  // comment above) the response no longer depends on the provider call's
  // latency anyway, so there is nothing left to equalise here.

  return ok(null);
}

/**
 * Consumes a password reset token: sets a new password and revokes every
 * live session for the account, in one transaction.
 *
 * Revoking sessions is the entire point of this flow existing, not an
 * afterthought: someone resetting their password because they suspect their
 * account was compromised gains nothing if an attacker's session is left
 * live. Unlike `refreshSession`'s reuse-detection branch (which revokes one
 * session, grouped by its `sessionId`, because only that one chain is known
 * to be compromised), this revokes *every* live `RefreshToken` row for the
 * user directly by `userId` -- the whole point here is "every session,
 * everywhere", not one chain. It still shares the same `revokedAt: null`
 * condition in the `WHERE` clause that `refreshSession` and
 * `updateStaff`'s disable-account path use (see `auth-service.ts` /
 * `staff-service.ts`): a concurrent request revoking the same row becomes a
 * no-op rather than a second write, not that it matters much for an
 * unconditional "revoke all" update.
 *
 * No distinct "expired" or "already used" code: Task 12 introduces no new
 * `DomainErrorCode` (unlike Task 11's four OTP codes). An unknown, expired
 * or already-consumed token is `TOKEN_INVALID`, the same code
 * `refreshSession` already returns for an unknown or expired refresh
 * token -- from the caller's point of view both are just "this token does
 * not work any more".
 */
export async function resetPassword(db: Db, token: string, newPassword: string): Promise<Result<null>> {
  const tokenHash = hashResetToken(token);
  const row = await db.passwordReset.findUnique({ where: { tokenHash } });

  // An invitation token (Phase 2B) lives in the same table but is not a
  // reset: it is only accepted by `acceptInvitation`, which also activates
  // the account and records the terms.
  if (!row || row.purpose !== 'RESET' || row.consumedAt || row.expiresAt <= new Date()) {
    return fail('TOKEN_INVALID');
  }

  const passwordHash = await hashPassword(newPassword);

  return db.$transaction(async (tx: DbTransactionClient): Promise<Result<null>> => {
    // Conditional: two uses of the same token cannot both win.
    const consumed = await tx.passwordReset.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) return fail('TOKEN_INVALID');

    const now = new Date();
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    // The account now has a password: a pending invitation link must not be
    // able to replace it.
    await tx.passwordReset.updateMany({
      where: { userId: row.userId, purpose: 'INVITATION', consumedAt: null },
      data: { consumedAt: now },
    });
    return ok(null);
  });
}
