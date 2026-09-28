import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from './tokens';

const SECRET = 'a'.repeat(32);
const claims: AccessTokenClaims = { sub: 'user-1', type: 'STAFF', locale: 'es', sid: 'session-1' };

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
