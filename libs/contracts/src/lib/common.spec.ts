import { describe, expect, it } from 'vitest';
import { localeSchema, problemSchema, uuidSchema } from './common';

describe('localeSchema', () => {
  it('accepts the two supported locales', () => {
    expect(localeSchema.safeParse('es').success).toBe(true);
    expect(localeSchema.safeParse('en').success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(localeSchema.safeParse('fr').success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a well-formed UUID', () => {
    expect(uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('problemSchema', () => {
  it('parses an RFC 7807 problem+json body', () => {
    const parsed = problemSchema.safeParse({
      type: 'https://rutamochilera.app/errors/permission_denied',
      title: 'PERMISSION_DENIED',
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { permission: 'trip.create' },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a body with no details', () => {
    const parsed = problemSchema.safeParse({
      type: 'about:blank',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(parsed.success).toBe(true);
  });

  it('never requires a message field', () => {
    const parsed = problemSchema.safeParse({
      type: 'about:blank',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(parsed.success && 'message' in parsed.data).toBe(false);
  });
});
