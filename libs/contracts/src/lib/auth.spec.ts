import { describe, expect, it } from 'vitest';
import {
  authenticatedUserSchema,
  loginRequestSchema,
  refreshRequestSchema,
  sessionResponseSchema,
} from './auth';

describe('loginRequestSchema', () => {
  it('accepts a valid login payload', () => {
    const parsed = loginRequestSchema.safeParse({
      email: 'admin@agency.test',
      password: 'Correct-Horse-1',
      deviceId: 'device-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a payload without an optional deviceId', () => {
    expect(loginRequestSchema.safeParse({ email: 'admin@agency.test', password: 'x' }).success).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(loginRequestSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(loginRequestSchema.safeParse({ email: 'admin@agency.test', password: '' }).success).toBe(false);
  });
});

describe('refreshRequestSchema', () => {
  it('accepts a non-empty refresh token', () => {
    expect(refreshRequestSchema.safeParse({ refreshToken: 'abc' }).success).toBe(true);
  });

  it('rejects an empty refresh token', () => {
    expect(refreshRequestSchema.safeParse({ refreshToken: '' }).success).toBe(false);
  });
});

describe('authenticatedUserSchema', () => {
  it('parses a staff user DTO', () => {
    const parsed = authenticatedUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'admin@agency.test',
      type: 'STAFF',
      locale: 'es',
      fullName: 'Admin',
      permissions: ['trip.view'],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('sessionResponseSchema', () => {
  it('parses a full session payload', () => {
    const parsed = sessionResponseSchema.safeParse({
      user: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'admin@agency.test',
        type: 'STAFF',
        locale: 'es',
        fullName: 'Admin',
        permissions: [],
      },
      tokens: {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresInSeconds: 900,
      },
    });
    expect(parsed.success).toBe(true);
  });
});
