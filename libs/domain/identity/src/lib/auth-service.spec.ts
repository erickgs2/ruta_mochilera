import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { resetLoginRateLimiterForTesting } from './login-rate-limiter';
import { hashPassword } from './password';
import { hashRefreshToken, verifyAccessToken } from './tokens';
import { login, logout, refreshSession, type AuthConfig } from './auth-service';

const db = withTestDb();
const config: AuthConfig = {
  jwtSecret: 'a'.repeat(32),
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
};

async function seedStaffUser(email = 'ana@agency.test', password = 'Correct-Horse-1') {
  const role = await db.role.create({ data: { name: 'Manager', description: 'Manages trips' } });
  const permission = await db.permission.create({
    data: { key: 'trip.create', category: 'trips', description: 'Create trips' },
  });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });

  const user = await db.user.create({
    data: {
      email,
      type: 'STAFF',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: 'Ana Ruiz' } },
      roles: { create: { roleId: role.id } },
    },
  });
  return user;
}

beforeAll(async () => {
  await prepareTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('login', () => {
  beforeEach(() => {
    // The rate limiter is in-memory, module-level state (see its own doc
    // comment): without this reset, failed-login tests below would bleed
    // into each other and eventually trip RATE_LIMITED for the wrong reason.
    resetLoginRateLimiterForTesting();
    return resetDatabase(db);
  });

  it('returns tokens and the flattened permission list on valid credentials', async () => {
    await seedStaffUser();
    const result = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.fullName).toBe('Ana Ruiz');
    expect(result.value.user.permissions).toEqual(['trip.create']);
    expect(result.value.tokens.accessToken.split('.')).toHaveLength(3);
    expect(result.value.tokens.expiresInSeconds).toBe(900);

    // The access token's claims are what Task 9/14 will trust for
    // authentication and session revocation: `sub` must identify this user
    // and `sid` must match the session the persisted refresh token belongs
    // to, not some unrelated or freshly minted id.
    const claims = await verifyAccessToken(result.value.tokens.accessToken, config.jwtSecret);
    expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    expect(claims.value.sub).toBe(result.value.user.id);
    const row = await db.refreshToken.findFirstOrThrow({ where: { userId: result.value.user.id } });
    expect(claims.value.sid).toBe(row.sessionId);
  });

  it('is case-insensitive on the email', async () => {
    await seedStaffUser();
    const result = await login(db, config, { email: 'ANA@Agency.test', password: 'Correct-Horse-1' });
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    await seedStaffUser();
    const result = await login(db, config, { email: 'ana@agency.test', password: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns INVALID_CREDENTIALS — not NOT_FOUND — for an unknown email', async () => {
    const result = await login(db, config, { email: 'ghost@agency.test', password: 'whatever' });
    expect(result.ok).toBe(false);
    // We never leak which emails are registered.
    if (!result.ok) expect(result.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a disabled account', async () => {
    const user = await seedStaffUser();
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    const result = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('persists exactly one refresh token row', async () => {
    await seedStaffUser();
    await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    expect(await db.refreshToken.count()).toBe(1);
  });

  describe('rate limiting', () => {
    it('returns RATE_LIMITED after five failed attempts against the same email, even from different IPs', async () => {
      await seedStaffUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await login(db, config, {
          email: 'ana@agency.test',
          password: 'wrong',
          ip: `10.0.0.${attempt}`,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('INVALID_CREDENTIALS');
      }

      const sixth = await login(db, config, { email: 'ana@agency.test', password: 'wrong', ip: '10.0.0.99' });
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');

      // The correct password is refused too, while rate-limited: the whole
      // point is to stop verifying passwords at all once the limit trips.
      const withCorrectPassword = await login(db, config, {
        email: 'ana@agency.test',
        password: 'Correct-Horse-1',
        ip: '10.0.0.99',
      });
      expect(withCorrectPassword.ok).toBe(false);
      if (!withCorrectPassword.ok) expect(withCorrectPassword.error.code).toBe('RATE_LIMITED');
    });

    it('returns RATE_LIMITED after five failed attempts from the same IP, even against different emails', async () => {
      await seedStaffUser('luis@agency.test');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await login(db, config, {
          email: `unknown-${attempt}@agency.test`,
          password: 'wrong',
          ip: '203.0.113.5',
        });
        expect(result.ok).toBe(false);
      }

      const sixth = await login(db, config, {
        email: 'luis@agency.test',
        password: 'Correct-Horse-1',
        ip: '203.0.113.5',
      });
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');
    });

    it('does not rate-limit a legitimate user whose password is correct on the first try', async () => {
      await seedStaffUser();
      const result = await login(db, config, {
        email: 'ana@agency.test',
        password: 'Correct-Horse-1',
        ip: '198.51.100.1',
      });
      expect(result.ok).toBe(true);
    });

    it('clears the counters on a successful login, so a later mistake is not immediately rate-limited', async () => {
      await seedStaffUser();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await login(db, config, { email: 'ana@agency.test', password: 'wrong', ip: '192.0.2.1' });
      }
      const success = await login(db, config, {
        email: 'ana@agency.test',
        password: 'Correct-Horse-1',
        ip: '192.0.2.1',
      });
      expect(success.ok).toBe(true);

      const afterReset = await login(db, config, {
        email: 'ana@agency.test',
        password: 'wrong',
        ip: '192.0.2.1',
      });
      expect(afterReset.ok).toBe(false);
      if (!afterReset.ok) expect(afterReset.error.code).toBe('INVALID_CREDENTIALS');
    });
  });
});

describe('refreshSession', () => {
  beforeEach(() => resetDatabase(db));

  it('rotates the token and revokes the old one', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');

    const refreshed = await refreshSession(db, config, { refreshToken: first.value.tokens.refreshToken });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.tokens.refreshToken).not.toBe(first.value.tokens.refreshToken);

    const rows = await db.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1].revokedAt).toBeNull();
    expect(rows[1].sessionId).toBe(rows[0].sessionId);

    // Rotation must carry the session id forward, not mint a new one: `sid`
    // is what Task 9/14 use to revoke a whole session, so a rotated access
    // token pointing at a fresh session id would silently break that.
    const claims = await verifyAccessToken(refreshed.value.tokens.accessToken, config.jwtSecret);
    expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    expect(claims.value.sub).toBe(first.value.user.id);
    expect(claims.value.sid).toBe(rows[1].sessionId);
  });

  it('detects reuse and revokes the whole session chain', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');
    const stolen = first.value.tokens.refreshToken;

    await refreshSession(db, config, { refreshToken: stolen }); // legitimate rotation
    const replay = await refreshSession(db, config, { refreshToken: stolen }); // replay of the stolen token

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('TOKEN_REUSED');

    const live = await db.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('detects a concurrent replay of the same token and leaves no live token', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');
    const stolen = first.value.tokens.refreshToken;

    // Two requests presenting the same refresh token at the same time: the
    // read-then-write race this guards against. Exactly one must rotate
    // (the transaction that wins the conditional update on the row) and the
    // other must observe the reuse -- neither may silently succeed alongside
    // the other, which is what an unconditional `update({ where: { id } })`
    // would allow.
    const [a, b] = await Promise.all([
      refreshSession(db, config, { refreshToken: stolen }),
      refreshSession(db, config, { refreshToken: stolen }),
    ]);

    const results = [a, b];
    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (!failures[0].ok) expect(failures[0].error.code).toBe('TOKEN_REUSED');

    // A reuse was detected on this session, so the whole chain is revoked --
    // including the token the "winning" call just issued. That call reports
    // success, but the token it returned must not actually be usable.
    const live = await db.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('rejects an unknown token', async () => {
    const result = await refreshSession(db, config, { refreshToken: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');
    await db.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const result = await refreshSession(db, config, { refreshToken: first.value.tokens.refreshToken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a disabled account even with a still-valid refresh token', async () => {
    const user = await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });

    const result = await refreshSession(db, config, { refreshToken: first.value.tokens.refreshToken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('logout', () => {
  beforeEach(() => resetDatabase(db));

  it('revokes the whole session and is idempotent', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');

    // Rotate once first: a session that never rotated only ever has one row,
    // and an implementation that revokes just the presented token would pass
    // every assertion below identically to one that revokes the whole
    // session. With two rows in the chain, asserting both end up revoked
    // actually exercises "the whole session", not just "the one row".
    const refreshed = await refreshSession(db, config, { refreshToken: first.value.tokens.refreshToken });
    if (!refreshed.ok) throw new Error('refresh failed');

    expect((await logout(db, { refreshToken: refreshed.value.tokens.refreshToken })).ok).toBe(true);

    const rows = await db.refreshToken.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    // A second logout with the same token must not fail.
    expect((await logout(db, { refreshToken: refreshed.value.tokens.refreshToken })).ok).toBe(true);
  });

  it('revokes a live sibling token sharing the same session id, not just the one presented', async () => {
    await seedStaffUser();
    const first = await login(db, config, { email: 'ana@agency.test', password: 'Correct-Horse-1' });
    if (!first.ok) throw new Error('login failed');

    const legit = await db.refreshToken.findFirstOrThrow({ where: { userId: first.value.user.id } });

    // Directly constructed: this models the state a rotation race would leave
    // behind if the fix in refreshSession ever regressed -- two live tokens
    // sharing one session id. login/refreshSession never produce this shape
    // themselves, but logout's chain-wide revocation is the defence against
    // it, so it has to be tested against the state it defends against, not
    // only states the public API can reach on its own.
    await db.refreshToken.create({
      data: {
        userId: legit.userId,
        sessionId: legit.sessionId,
        tokenHash: hashRefreshToken('sibling-token-from-a-hypothetical-rotation-race'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    expect((await logout(db, { refreshToken: first.value.tokens.refreshToken })).ok).toBe(true);

    const rows = await db.refreshToken.findMany({ where: { sessionId: legit.sessionId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});
