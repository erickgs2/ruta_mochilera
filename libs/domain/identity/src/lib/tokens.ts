import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { fail, ok, type Result } from '@rm/shared-utils';

export interface AccessTokenClaims {
  sub: string;
  type: 'STAFF' | 'CUSTOMER';
  locale: 'es' | 'en';
  /** Session id, shared with the refresh-token chain so a session can be revoked whole. */
  sid: string;
}

const ISSUER = 'ruta-mochilera';
const AUDIENCE = 'ruta-mochilera-clients';

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: claims.type, locale: claims.locale, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<Result<AccessTokenClaims>> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string') {
      return fail('TOKEN_INVALID');
    }
    return ok({
      sub: payload.sub,
      type: payload['type'] as AccessTokenClaims['type'],
      locale: payload['locale'] as AccessTokenClaims['locale'],
      sid: payload['sid'],
    });
  } catch {
    // Any verification failure (bad signature, expired token, malformed
    // input) is a non-match, never an exception a caller must handle.
    return fail('TOKEN_INVALID');
  }
}

/** Opaque refresh token. Only its SHA-256 hash is ever persisted. */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
