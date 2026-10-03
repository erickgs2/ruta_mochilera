import { randomUUID } from 'node:crypto';
import type { Db, DbTransactionClient } from '@rm/db';
import { loadActorPermissions } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';
import { clearLoginRateLimit, isLoginRateLimited, recordFailedLoginAttempt } from './login-rate-limiter';
import { verifyPassword } from './password';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';

export interface AuthConfig {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  type: 'STAFF' | 'CUSTOMER';
  locale: 'es' | 'en';
  fullName: string;
  permissions: string[];
}

interface SessionInput {
  deviceId?: string;
  userAgent?: string;
}

/**
 * A precomputed argon2id hash of an arbitrary, unrelated password.
 *
 * `login` verifies against this constant when the email doesn't match any
 * user, so that branch spends the same argon2 time as a real, wrong-password
 * attempt instead of returning immediately. Without it, an unknown email
 * short-circuits before ever touching argon2 while a wrong password runs a
 * full verification; that gap (tens of milliseconds against sub-millisecond)
 * is trivially measurable over HTTP and reopens exactly the account-existence
 * oracle the shared `INVALID_CREDENTIALS` error code is meant to close.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$NvhLQhsRiMl5pBHiVnTc3g$FxBLuVG4mI516VO73fcQrsshSj7nUNEf1/VXrudzo2o';

/**
 * Issues a fresh refresh token row plus a signed access token for an existing
 * session id.
 *
 * Typed to accept `DbTransactionClient` rather than `Db` so it can run either
 * standalone (login) or as part of `db.$transaction(async (tx) => ...)`
 * (refresh rotation) with no cast at either call site: a full `Db` is
 * structurally assignable to `DbTransactionClient`.
 */
async function issueSession(
  db: DbTransactionClient,
  config: AuthConfig,
  userId: string,
  sessionId: string,
  input: SessionInput
): Promise<SessionTokens> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const { token, tokenHash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

  await db.refreshToken.create({
    data: {
      userId,
      sessionId,
      tokenHash,
      deviceId: input.deviceId,
      userAgent: input.userAgent,
      expiresAt,
    },
  });

  const accessToken = await signAccessToken(
    { sub: userId, type: user.type, locale: user.locale, sid: sessionId },
    config.jwtSecret,
    config.accessTokenTtlSeconds
  );

  return { accessToken, refreshToken: token, expiresInSeconds: config.accessTokenTtlSeconds };
}

/**
 * Shapes the profile DTO shared by `login`, `refreshSession` and the `/me`
 * endpoint: exported so the HTTP layer never re-implements this lookup (and
 * its staff/customer `fullName` fallback) directly against Prisma.
 */
export async function describeUser(db: Db, userId: string): Promise<AuthenticatedUser> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    include: { staffProfile: true, customerProfile: true },
  });
  return {
    id: user.id,
    email: user.email,
    type: user.type,
    locale: user.locale,
    fullName: user.staffProfile?.fullName ?? user.customerProfile?.fullName ?? '',
    permissions: user.type === 'STAFF' ? await loadActorPermissions(db, user.id) : [],
  };
}

export async function login(
  db: Db,
  config: AuthConfig,
  input: { email: string; password: string; ip?: string } & SessionInput
): Promise<Result<{ user: AuthenticatedUser; tokens: SessionTokens }>> {
  // Normalised the same way the duplicate-email check and the write path
  // normalise it (see `staff-service.createStaff`): two spellings of the same
  // address must share one rate-limit bucket, not reset it by casing alone.
  const email = input.email.trim().toLowerCase();
  const ip = input.ip ?? 'unknown';

  // Checked before any password work at all -- including the dummy-hash
  // timing defence below -- so a rate-limited burst never spends argon2 time,
  // which is the whole point of limiting it.
  if (isLoginRateLimited(email, ip)) return fail('RATE_LIMITED');

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });

  // Same error code for a nonexistent user and a wrong password: telling them
  // apart would reveal which emails are registered. Also run argon2 on the
  // miss path (against the fixed dummy hash) so the two branches take
  // comparable time -- an unknown email that returned instantly would leak
  // through timing what the shared error code hides.
  if (!user?.passwordHash) {
    await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
    recordFailedLoginAttempt(email, ip);
    return fail('INVALID_CREDENTIALS');
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    recordFailedLoginAttempt(email, ip);
    return fail('INVALID_CREDENTIALS');
  }
  if (user.status === 'DISABLED') return fail('ACCOUNT_DISABLED');

  clearLoginRateLimit(email, ip);
  const tokens = await issueSession(db, config, user.id, randomUUID(), input);
  return ok({ user: await describeUser(db, user.id), tokens });
}

export async function refreshSession(
  db: Db,
  config: AuthConfig,
  input: { refreshToken: string } & SessionInput
): Promise<Result<{ user: AuthenticatedUser; tokens: SessionTokens }>> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const existing = await db.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) return fail('TOKEN_INVALID');

  // Presenting an already-rotated token means someone kept a copy of it:
  // revoke the whole session, not just this one token.
  if (existing.revokedAt) {
    await db.refreshToken.updateMany({
      where: { sessionId: existing.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return fail('TOKEN_REUSED');
  }

  if (existing.expiresAt <= new Date()) return fail('TOKEN_INVALID');

  const user = await db.user.findUnique({ where: { id: existing.userId } });
  if (!user || user.status === 'DISABLED') return fail('ACCOUNT_DISABLED');

  // Revoking the old token and issuing the new one must be atomic: a crash
  // between the two steps must never leave the session without a live
  // refresh token.
  //
  // The revoke is also made conditional on `revokedAt: null` rather than an
  // unconditional update by id. The `existing.revokedAt` check above ran
  // outside this transaction, so two concurrent requests presenting the same
  // token can both read it as live and both reach this point: without the
  // condition, both updates would succeed and both would issue a new token,
  // leaving two live tokens in one chain and defeating reuse detection
  // entirely. With the condition, Postgres serialises the two UPDATEs on the
  // same row; the second one re-evaluates its WHERE clause against the
  // first's now-committed result and matches zero rows, so exactly one
  // request rotates and the other is treated as a (concurrent) replay.
  const outcome = await db.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      await tx.refreshToken.updateMany({
        where: { sessionId: existing.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { reused: true } as const;
    }
    const tokens = await issueSession(tx, config, existing.userId, existing.sessionId, input);
    return { reused: false, tokens } as const;
  });

  if (outcome.reused) return fail('TOKEN_REUSED');
  return ok({ user: await describeUser(db, existing.userId), tokens: outcome.tokens });
}

export async function logout(db: Db, input: { refreshToken: string }): Promise<Result<null>> {
  const existing = await db.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(input.refreshToken) },
  });

  // Closing an already-closed session is not an error.
  if (existing) {
    await db.refreshToken.updateMany({
      where: { sessionId: existing.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  return ok(null);
}
