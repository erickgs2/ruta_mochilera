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
 * The refresh token is deliberately absent here: it never appears in a JSON
 * response body. `/auth/login` and `/auth/refresh` deliver it only as an
 * httpOnly, Secure, SameSite=Strict cookie (see
 * `apps/api/src/lib/http/refresh-cookie.ts` and the spec's security section,
 * §10) -- a token a script on the page can read is a token XSS can steal.
 */
export const sessionResponseSchema = z.object({
  user: authenticatedUserSchema,
  tokens: z.object({
    accessToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
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
