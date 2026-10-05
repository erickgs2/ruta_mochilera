import { z } from 'zod';
import { localeSchema, uuidSchema } from './common';

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().max(128).optional(),
});

export const authenticatedUserSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  type: z.enum(['STAFF', 'CUSTOMER']),
  locale: localeSchema,
  fullName: z.string(),
  permissions: z.array(z.string()),
});

/**
 * `refreshToken` is absent from this response for a web caller -- the only
 * client this API served until Task 15b. `/auth/login` and `/auth/refresh`
 * deliver the token to the browser only as an httpOnly, Secure,
 * SameSite=Strict cookie (see `apps/api/src/lib/http/refresh-cookie.ts` and
 * the spec's security section, §10) -- a token a script on the page can
 * read is a token XSS can steal, and that invariant is unchanged and
 * enforced at the route level (`sessionResponse`'s `'web'` branch never
 * sets this field; see `auth.integration.spec.ts`).
 *
 * It is `optional()`, not absent from the type entirely, because Task 15
 * found that same httpOnly cookie does not survive inside a packaged
 * Capacitor app (cross-origin, `SameSite=Strict` blocks it) --
 * `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`.
 * The chosen fix reverts the native client to Phase 1's original model:
 * secure OS storage (Keychain/Keystore) instead of a cookie, which means the
 * native app's own JS must receive the raw token once, from this very
 * response, in order to hand it to that storage. The server only takes this
 * branch when the caller marks itself `X-Client-Platform: native`
 * (`clientPlatform` in `refresh-cookie.ts`) -- nothing a browser does can
 * produce that marker, so this optional field never appears for one.
 */
export const sessionResponseSchema = z.object({
  user: authenticatedUserSchema,
  tokens: z.object({
    accessToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
    refreshToken: z.string().optional(),
  }),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthenticatedUserDto = z.infer<typeof authenticatedUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * The five public endpoints Tasks 11-12 add on top of `/auth/login`. Every
 * one of them responds with a bare `null` body on success (never a DTO that
 * could differ between branches) -- see `registerCustomer`,
 * `resendVerificationCode` and `requestPasswordReset` in
 * `@rm/domain-identity` for why: none of these may leak, through response
 * shape, whether the email they were given belongs to an existing account.
 */
export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(128),
  fullName: z.string().min(3).max(120),
  phone: z.string().min(7).max(30),
  birthDate: z.iso.date(),
  // `z.literal(true)`, not `z.boolean()`: an omitted or `false` value must
  // fail validation outright rather than silently registering someone who
  // never accepted the terms.
  acceptTerms: z.literal(true),
});

export const verifyEmailRequestSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'must be six digits'),
});

export const resendCodeRequestSchema = z.object({
  email: z.string().email(),
});

export const forgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ResendCodeRequest = z.infer<typeof resendCodeRequestSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/**
 * Body for `POST /auth/oauth/google` and `POST /auth/oauth/apple` (Task 13).
 * Which provider to verify against is the URL path, not a field here -- each
 * route calls `loginWithProvider` with its own fixed `provider`. Responds
 * with `sessionResponseSchema`, the same as `/auth/login`: a social sign-in
 * produces a session the exact same way a password one does, refresh token
 * included only as the httpOnly cookie, never in this response body.
 */
export const socialLoginRequestSchema = z.object({
  idToken: z.string().min(1),
  deviceId: z.string().max(128).optional(),
});

export type SocialLoginRequest = z.infer<typeof socialLoginRequestSchema>;
