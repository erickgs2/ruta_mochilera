import { z } from 'zod';
import { localeSchema, uuidSchema } from './common';

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().max(128).optional(),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const authenticatedUserSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  type: z.enum(['STAFF', 'CUSTOMER']),
  locale: localeSchema,
  fullName: z.string(),
  permissions: z.array(z.string()),
});

export const sessionResponseSchema = z.object({
  user: authenticatedUserSchema,
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
  }),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type AuthenticatedUserDto = z.infer<typeof authenticatedUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
