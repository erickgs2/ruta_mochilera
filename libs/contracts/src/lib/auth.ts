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
