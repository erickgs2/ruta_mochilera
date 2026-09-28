import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from './tokens';

const SECRET = 'a'.repeat(32);
const claims: AccessTokenClaims = { sub: 'user-1', type: 'STAFF', locale: 'es', sid: 'session-1' };

// Mirrors the private ISSUER/AUDIENCE constants in tokens.ts. Needed here to
// hand-craft tokens (via jose directly) that carry a claim signAccessToken
// would never produce, so these tests can reach verifyAccessToken's
// validation of fields it does not control.
const ISSUER = 'ruta-mochilera';
const AUDIENCE = 'ruta-mochilera-clients';

async function signRawToken(
  payload: Record<string, unknown>,
  alg: string,
  secret: string = SECRET
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg })
    .setSubject('user-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(new TextEncoder().encode(secret));
}

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    const token = await signAccessToken(claims, SECRET, 900);
    const result = await verifyAccessToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe('user-1');
      expect(result.value.type).toBe('STAFF');
      expect(result.value.sid).toBe('session-1');
    }
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signAccessToken(claims, SECRET, 900);
    const result = await verifyAccessToken(token, 'b'.repeat(32));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken(claims, SECRET, -1);
    const result = await verifyAccessToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects garbage', async () => {
    const result = await verifyAccessToken('not.a.token', SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects a token whose header declares a different HMAC algorithm', async () => {
    // Same secret, same claims, just a relabeled alg (HS384 instead of
    // HS256). jose accepts a raw Uint8Array key for any HMAC variant, so
    // without an explicit `algorithms: ['HS256']` allowlist this verifies
    // successfully by accident of key material rather than by declaration.
    const token = await signRawToken(
      { type: claims.type, locale: claims.locale, sid: claims.sid },
      'HS384'
    );
    const result = await verifyAccessToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose type claim is outside the STAFF|CUSTOMER union', async () => {
    const token = await signRawToken({ type: 'staff', locale: claims.locale, sid: claims.sid }, 'HS256');
    const result = await verifyAccessToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose locale claim is outside the es|en union', async () => {
    const token = await signRawToken({ type: claims.type, locale: 'fr', sid: claims.sid }, 'HS256');
    const result = await verifyAccessToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
  });
});

describe('refresh tokens', () => {
  it('generates an opaque token with its hash', () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(tokenHash).not.toBe(token);
  });

  it('generates a different token every time', () => {
    expect(generateRefreshToken().token).not.toBe(generateRefreshToken().token);
  });
});
