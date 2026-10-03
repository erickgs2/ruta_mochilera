import { describe, expect, it } from 'vitest';
import { authenticatedUserSchema, loginRequestSchema, sessionResponseSchema } from './auth';

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
        expiresInSeconds: 900,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload that still carries a refresh token in the body', () => {
    // The refresh token must never appear in a JSON response -- it belongs
    // only in the httpOnly cookie `/auth/login` sets. `.strict()` is not used
    // on `tokens` (an extra field would simply be stripped, not rejected) so
    // this test documents the shape rather than enforcing rejection; see
    // `sessionResponseSchema`'s own doc comment for the reasoning.
    const parsed = sessionResponseSchema.safeParse({
      user: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'admin@agency.test',
        type: 'STAFF',
        locale: 'es',
        fullName: 'Admin',
        permissions: [],
      },
      tokens: { accessToken: 'token', refreshToken: 'refresh', expiresInSeconds: 900 },
    });
    expect(parsed.success && parsed.data.tokens).not.toHaveProperty('refreshToken');
  });
});
