import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { uniqueViolationIndex, type Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import { describeUser, issueSession, type AuthConfig, type AuthenticatedUser, type SessionInput, type SessionTokens } from './auth-service';

export type SocialProvider = 'GOOGLE' | 'APPLE';

/**
 * `AuthConfig` plus the two client ids a social login needs. Named after the
 * `AppEnv` fields they come from (`googleOauthClientId`/`appleOauthClientId`)
 * so `config()` -- which already returns `AppEnv` -- is passed straight
 * through at the route, the same way `login`/`refreshSession` take `config()`
 * directly as their own `AuthConfig`.
 *
 * Empty or absent means the provider is switched off: see `loginWithProvider`
 * below. Deliberately not narrowed to a non-empty string type -- the whole
 * point is that an operator can leave these blank in `.env` with no other
 * code change.
 */
export interface SocialLoginConfig extends AuthConfig {
  googleOauthClientId?: string;
  appleOauthClientId?: string;
}

export interface SocialLoginInput extends SessionInput {
  provider: SocialProvider;
  idToken: string;
}

/** What a verified id token tells us about the person who signed in -- nothing more. */
export interface VerifiedIdentity {
  providerUserId: string;
  email: string;
}

/**
 * Checks signature, issuer, audience and expiry (`clientId` is always
 * checked as the required `aud`) and returns the two claims `loginWithProvider`
 * needs. A token failing any of those checks -- including, critically, one
 * correctly signed but minted for a *different* application's client id --
 * is `TOKEN_INVALID`, never a thrown exception.
 */
export type IdTokenVerifier = (idToken: string, clientId: string) => Promise<Result<VerifiedIdentity>>;

export interface ProviderVerifiers {
  GOOGLE: IdTokenVerifier;
  APPLE: IdTokenVerifier;
}

/**
 * Builds an `IdTokenVerifier` against a given issuer and key source.
 *
 * Exported (not just used internally by `defaultProviderVerifiers` below) so
 * tests can build the exact same verifier against a local, deterministic
 * `JWKSet` instead of a remote one -- see `social-login.spec.ts`'s doc
 * comment for why that is the chosen way to get deterministic signing keys
 * into a test without ever reaching the network. Production and tests then
 * share one verification implementation; only the key *source* differs.
 *
 * `algorithms: ['RS256']` is pinned explicitly, the same defensive reasoning
 * `verifyAccessToken` in `./tokens.ts` documents for its own `HS256`: without
 * it, jose's algorithm allow-list check is skipped, and while a JWKS-backed
 * key resolver already can't be tricked into verifying an HS256 token with
 * an RSA public key (the key types don't match), pinning the algorithm here
 * means that protection does not depend on that happening to be true.
 */
export function createJwksVerifier(issuer: string | string[], getKey: JWTVerifyGetKey): IdTokenVerifier {
  return async (idToken, clientId) => {
    try {
      const { payload } = await jwtVerify(idToken, getKey, {
        issuer,
        audience: clientId,
        algorithms: ['RS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload['email'] !== 'string') {
        return fail('TOKEN_INVALID');
      }
      return ok({ providerUserId: payload.sub, email: payload['email'] });
    } catch {
      // Any verification failure -- bad signature, wrong issuer, wrong
      // audience, expired, malformed -- is a non-match, never an exception a
      // caller must handle. Same contract as `verifyAccessToken`.
      return fail('TOKEN_INVALID');
    }
  };
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';

/**
 * `createRemoteJWKSet` caches the fetched key set internally and re-fetches
 * on a cache miss (e.g. an unknown `kid`, which is exactly what a provider's
 * own key rotation looks like) -- building it once per process, not per
 * call, is what lets that cache actually do its job.
 */
export const defaultProviderVerifiers: ProviderVerifiers = {
  GOOGLE: createJwksVerifier(GOOGLE_ISSUER, createRemoteJWKSet(new URL(GOOGLE_JWKS_URI))),
  APPLE: createJwksVerifier(APPLE_ISSUER, createRemoteJWKSet(new URL(APPLE_JWKS_URI))),
};

/**
 * Signs in with a verified Google or Apple id token, producing a session the
 * exact same way `login` does (`issueSession`, shared refresh-token rotation
 * and reuse detection included) -- never a hand-minted token.
 *
 * Three cases, in order:
 *
 * 1. **Provider switched off.** `config.google/appleOauthClientId` is empty
 *    or absent (the shipped `.env.example` default, pending real Google/Apple
 *    developer accounts) -- `PROVIDER_DISABLED`, and the verifier is never
 *    invoked: there is no client id to check an audience against anyway.
 * 2. **Known `AuthIdentity`.** The `(provider, providerUserId)` pair is
 *    already linked -- sign in as that user.
 * 3. **Unknown `AuthIdentity`, known email.** An account already exists
 *    (almost always a password account) with this email -- link a new
 *    `AuthIdentity` to it rather than creating a second user, and mark the
 *    email verified if it was not already (the provider verified it; this
 *    sign-in attempt itself just proved the caller controls it).
 * 4. **Unknown `AuthIdentity`, unknown email.** A brand-new `CUSTOMER` is
 *    created with `emailVerifiedAt` set immediately -- the provider already
 *    verified the email, so routing this through the six-digit email OTP
 *    flow `registerCustomer` uses would be redundant.
 *
 * Deliberately creates the `User` row without a `CustomerProfile`: Google
 * and Apple id tokens carry no phone number and no birth date (both are
 * `CustomerProfile` `NOT NULL` columns), so there is no real data to put
 * there. `describeUser` already tolerates a missing profile (falls back to
 * an empty `fullName`); completing the profile is a separate, later concern
 * this task does not touch.
 *
 * `ACCOUNT_DISABLED` is checked for every existing-user path (2 and 3), the
 * same as `login` and `refreshSession` -- a disabled account must not be
 * reachable through a second sign-in method either. A brand-new account
 * (case 4) is always `ACTIVE` by default, so there is nothing to check there.
 *
 * `verifiers` defaults to the real, network-backed Google/Apple key sets;
 * overriding it is how `social-login.spec.ts` gets deterministic answers
 * without a network call -- see `createJwksVerifier`'s doc comment.
 */
export async function loginWithProvider(
  db: Db,
  config: SocialLoginConfig,
  input: SocialLoginInput,
  verifiers: ProviderVerifiers = defaultProviderVerifiers
): Promise<Result<{ user: AuthenticatedUser; tokens: SessionTokens }>> {
  const clientId = input.provider === 'GOOGLE' ? config.googleOauthClientId : config.appleOauthClientId;
  if (!clientId) return fail('PROVIDER_DISABLED');

  const verified = await verifiers[input.provider](input.idToken, clientId);
  if (!verified.ok) return verified;

  const email = verified.value.email.trim().toLowerCase();
  const providerUserId = verified.value.providerUserId;

  type LinkOutcome = { kind: 'ok'; userId: string } | { kind: 'disabled' };

  let outcome: LinkOutcome;
  try {
    outcome = await db.$transaction(async (tx): Promise<LinkOutcome> => {
      const existingIdentity = await tx.authIdentity.findUnique({
        where: { provider_providerUserId: { provider: input.provider, providerUserId } },
      });

      if (existingIdentity) {
        const user = await tx.user.findUniqueOrThrow({ where: { id: existingIdentity.userId } });
        return user.status === 'DISABLED' ? { kind: 'disabled' } : { kind: 'ok', userId: user.id };
      }

      const existingUser = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (existingUser) {
        if (existingUser.status === 'DISABLED') return { kind: 'disabled' };
        await tx.authIdentity.create({ data: { userId: existingUser.id, provider: input.provider, providerUserId } });
        if (!existingUser.emailVerifiedAt) {
          await tx.user.update({ where: { id: existingUser.id }, data: { emailVerifiedAt: new Date() } });
        }
        return { kind: 'ok', userId: existingUser.id };
      }

      const created = await tx.user.create({ data: { email, type: 'CUSTOMER', emailVerifiedAt: new Date() } });
      await tx.authIdentity.create({ data: { userId: created.id, provider: input.provider, providerUserId } });
      return { kind: 'ok', userId: created.id };
    });
  } catch (error) {
    // A concurrent sign-in with the same brand-new identity or email (e.g. a
    // double-tapped "Sign in with Google" button) can lose a unique-
    // constraint race on `auth_identities` or `users` after this function's
    // own pre-checks above both read "not found yet". The loser retries once
    // instead of surfacing a raw 500: by the time it re-runs, the winner's
    // row is visible and this becomes an ordinary "known identity" or "known
    // email" case. Same shape of fix `registerCustomer` applies to its own
    // analogous race (see `customer-registration.ts`), and likewise not
    // covered by a dedicated forced-interleaving test -- the brief's six
    // required cases do not include this race, and forcing this specific
    // interleaving would need the same paused-transaction harness Task 7/8
    // use for reservation/payment concurrency, which is more test machinery
    // than this edge case has earned on its own.
    if (uniqueViolationIndex(error) !== undefined) {
      return loginWithProvider(db, config, input, verifiers);
    }
    throw error;
  }

  if (outcome.kind === 'disabled') return fail('ACCOUNT_DISABLED');

  const tokens = await issueSession(db, config, outcome.userId, randomUUID(), input);
  return ok({ user: await describeUser(db, outcome.userId), tokens });
}
