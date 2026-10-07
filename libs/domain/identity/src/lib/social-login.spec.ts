import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type CryptoKey } from 'jose';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword } from './password';
import { createJwksVerifier, loginWithProvider, type ProviderVerifiers, type SocialLoginConfig } from './social-login';

const db = withTestDb();

const OUR_GOOGLE_CLIENT_ID = 'our-app.apps.googleusercontent.com';
const OUR_APPLE_CLIENT_ID = 'com.ruta-mochilera.app';
const SOMEONE_ELSES_CLIENT_ID = 'someone-elses-app.apps.googleusercontent.com';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const APPLE_ISSUER = 'https://appleid.apple.com';

const config: SocialLoginConfig = {
  jwtSecret: 'x'.repeat(32),
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  googleOauthClientId: OUR_GOOGLE_CLIENT_ID,
  appleOauthClientId: OUR_APPLE_CLIENT_ID,
};

/**
 * Deterministic, network-free stand-in for Google's and Apple's published
 * keys: a real RSA keypair generated once for the suite, exposed through
 * `createLocalJWKSet` instead of `createRemoteJWKSet`. `createJwksVerifier`
 * is the exact function the production verifiers (`defaultProviderVerifiers`
 * in `./social-login.ts`) are built from -- only the key *source* differs
 * here, never the signature/issuer/audience/expiry check itself. This is
 * the deliberate choice for getting deterministic signing keys into tests
 * without ever reaching the network: see the Task 13 report for the
 * reasoning.
 */
let signingKey: CryptoKey;
let otherKey: CryptoKey; // an unrelated keypair: signs a token no verifier here ever trusts.
let verifiers: ProviderVerifiers;

async function signIdToken(options: {
  sub: string;
  email: string;
  issuer?: string;
  audience?: string;
  key?: CryptoKey;
  issuedSecondsAgo?: number;
  expiresInSeconds?: number;
  emailVerified?: boolean | 'true' | 'false'; // Apple sends this claim as the string 'true'/'false', not a boolean.
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000) - (options.issuedSecondsAgo ?? 0);
  return new SignJWT({ email: options.email, email_verified: options.emailVerified ?? true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.sub)
    .setIssuer(options.issuer ?? GOOGLE_ISSUER)
    .setAudience(options.audience ?? OUR_GOOGLE_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(options.key ?? signingKey);
}

beforeAll(async () => {
  await prepareTestDb();

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const localJwks = createLocalJWKSet({ keys: [jwk] });

  otherKey = (await generateKeyPair('RS256')).privateKey;

  // Both providers point at the same local JWKS in this suite: the thing
  // under test is the shared verification logic (signature / issuer /
  // audience / expiry), not which provider's real keys happen to be behind
  // it, and `createJwksVerifier` is provider-agnostic.
  verifiers = {
    GOOGLE: createJwksVerifier(GOOGLE_ISSUER, localJwks),
    APPLE: createJwksVerifier(APPLE_ISSUER, localJwks),
  };
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
});

describe('loginWithProvider', () => {
  it('creates a new user with email_verified_at set from a valid token for a brand-new email', async () => {
    const idToken = await signIdToken({ sub: 'google-sub-1', email: 'new.social@example.com' });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.email).toBe('new.social@example.com');
    expect(result.value.tokens.accessToken).toBeTruthy();

    const user = await db.user.findUniqueOrThrow({ where: { id: result.value.user.id } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.type).toBe('CUSTOMER');

    const identity = await db.authIdentity.findUnique({
      where: { provider_providerUserId: { provider: 'GOOGLE', providerUserId: 'google-sub-1' } },
    });
    expect(identity?.userId).toBe(user.id);
  });

  it('links an AuthIdentity to an existing password account instead of creating a second user', async () => {
    const existing = await db.user.create({
      data: {
        email: 'existing.password@example.com',
        type: 'CUSTOMER',
        passwordHash: await hashPassword('Correct-Horse-1'),
        customerProfile: {
          create: { fullName: 'Existing Customer', phone: '+52 55 0000 0000', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
        },
      },
    });
    expect(existing.emailVerifiedAt).toBeNull();

    const idToken = await signIdToken({ sub: 'google-sub-2', email: 'existing.password@example.com' });
    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.id).toBe(existing.id);

    const userCount = await db.user.count({ where: { email: { equals: 'existing.password@example.com', mode: 'insensitive' } } });
    expect(userCount).toBe(1);

    const refreshed = await db.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(refreshed.emailVerifiedAt).not.toBeNull();

    const identity = await db.authIdentity.findUnique({
      where: { provider_providerUserId: { provider: 'GOOGLE', providerUserId: 'google-sub-2' } },
    });
    expect(identity?.userId).toBe(existing.id);
  });

  it('rejects a token with an invalid signature', async () => {
    const idToken = await signIdToken({ sub: 'google-sub-3', email: 'bad-signature@example.com', key: otherKey });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_INVALID');
    await expect(db.user.findFirst({ where: { email: 'bad-signature@example.com' } })).resolves.toBeNull();
  });

  it('rejects a token whose audience is not our client id (a token issued for a different application)', async () => {
    const idToken = await signIdToken({
      sub: 'google-sub-4',
      email: 'wrong-audience@example.com',
      audience: SOMEONE_ELSES_CLIENT_ID,
    });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_INVALID');
    await expect(db.user.findFirst({ where: { email: 'wrong-audience@example.com' } })).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const idToken = await signIdToken({
      sub: 'google-sub-5',
      email: 'expired@example.com',
      issuedSecondsAgo: 7200,
      expiresInSeconds: 3600, // issued 2h ago, expired 1h ago
    });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('refuses to break any of the four checks: a tampered-but-well-formed token on every axis still fails', async () => {
    // Belt-and-suspenders: prove the protection is not accidentally
    // vacuous by breaking it deliberately (wrong issuer) and confirming
    // this still-plausible-looking token is rejected too.
    const idToken = await signIdToken({ sub: 'google-sub-6', email: 'wrong-issuer@example.com', issuer: 'https://evil.example.com' });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose email_verified claim is false: "already verified by the provider" must actually be checked, not assumed', async () => {
    const idToken = await signIdToken({ sub: 'google-sub-8', email: 'unverified@example.com', emailVerified: false });

    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMAIL_NOT_VERIFIED');
    await expect(db.user.findFirst({ where: { email: 'unverified@example.com' } })).resolves.toBeNull();
  });

  it('rejects email_verified: "false" (Apple\'s string form of the claim) the same as the boolean', async () => {
    const idToken = await signIdToken({ sub: 'apple-sub-1', email: 'apple-unverified@example.com', issuer: APPLE_ISSUER, audience: OUR_APPLE_CLIENT_ID, emailVerified: 'false' });

    const result = await loginWithProvider(db, config, { provider: 'APPLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it("accepts Apple's string form 'true' for email_verified", async () => {
    const idToken = await signIdToken({ sub: 'apple-sub-2', email: 'apple-verified@example.com', issuer: APPLE_ISSUER, audience: OUR_APPLE_CLIENT_ID, emailVerified: 'true' });

    const result = await loginWithProvider(db, config, { provider: 'APPLE', idToken }, verifiers);

    expect(result.ok).toBe(true);
  });

  it('returns PROVIDER_DISABLED without ever invoking the verifier when the client id is empty', async () => {
    const neverCalledVerifiers: ProviderVerifiers = {
      GOOGLE: () => {
        throw new Error('must not be called when the provider is disabled');
      },
      APPLE: () => {
        throw new Error('must not be called when the provider is disabled');
      },
    };
    const disabledConfig: SocialLoginConfig = { ...config, googleOauthClientId: '' };

    const result = await loginWithProvider(db, disabledConfig, { provider: 'GOOGLE', idToken: 'irrelevant' }, neverCalledVerifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_DISABLED');
  });

  it('treats an absent (undefined) client id the same as an empty one', async () => {
    const disabledConfig: SocialLoginConfig = { ...config, appleOauthClientId: undefined };

    const result = await loginWithProvider(db, disabledConfig, { provider: 'APPLE', idToken: 'irrelevant' }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_DISABLED');
  });

  it('rejects a disabled (soft-deleted) account even via a valid token linked by AuthIdentity', async () => {
    const existing = await db.user.create({
      data: { email: 'disabled.social@example.com', type: 'CUSTOMER', status: 'DISABLED' },
    });
    await db.authIdentity.create({ data: { userId: existing.id, provider: 'GOOGLE', providerUserId: 'google-sub-7' } });

    const idToken = await signIdToken({ sub: 'google-sub-7', email: 'disabled.social@example.com' });
    const result = await loginWithProvider(db, config, { provider: 'GOOGLE', idToken }, verifiers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ACCOUNT_DISABLED');
  });
});
