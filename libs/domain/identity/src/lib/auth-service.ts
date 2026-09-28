import { randomUUID } from 'node:crypto';
import type { Db, DbTransactionClient } from '@rm/db';
import { loadActorPermissions } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';
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

async function describeUser(db: DbTransactionClient, userId: string): Promise<AuthenticatedUser> {
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
  input: { email: string; password: string } & SessionInput
): Promise<Result<{ user: AuthenticatedUser; tokens: SessionTokens }>> {
  const user = await db.user.findFirst({
    where: { email: { equals: input.email, mode: 'insensitive' } },
  });

  // Same error code for a nonexistent user and a wrong password: telling them
  // apart would reveal which emails are registered.
  if (!user?.passwordHash) return fail('INVALID_CREDENTIALS');
  if (!(await verifyPassword(user.passwordHash, input.password))) return fail('INVALID_CREDENTIALS');
  if (user.status === 'DISABLED') return fail('ACCOUNT_DISABLED');

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
  const tokens = await db.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
    return issueSession(tx, config, existing.userId, existing.sessionId, input);
  });

  return ok({ user: await describeUser(db, existing.userId), tokens });
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
