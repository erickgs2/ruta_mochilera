import { describe, expect, it } from 'vitest';
import { problemResponse, statusForCode } from './problem';

describe('statusForCode', () => {
  it('maps authentication failures to 401', () => {
    expect(statusForCode('INVALID_CREDENTIALS')).toBe(401);
    expect(statusForCode('TOKEN_INVALID')).toBe(401);
    expect(statusForCode('TOKEN_REUSED')).toBe(401);
  });

  it('maps authorization failures to 403', () => {
    expect(statusForCode('PERMISSION_DENIED')).toBe(403);
    expect(statusForCode('ACCOUNT_DISABLED')).toBe(403);
    expect(statusForCode('EMAIL_NOT_VERIFIED')).toBe(403);
  });

  it('maps conflicts to 409 and validation to 422', () => {
    expect(statusForCode('TRIP_SOLD_OUT')).toBe(409);
    expect(statusForCode('DUPLICATE_RESERVATION')).toBe(409);
    expect(statusForCode('VALIDATION_FAILED')).toBe(422);
    expect(statusForCode('NOT_FOUND')).toBe(404);
  });
});

describe('statusForCode, free-amount payments', () => {
  it('refuses a payment below the minimum or by an unavailable method with 422, and a settled reservation with 409', () => {
    expect(statusForCode('PAYMENT_BELOW_MINIMUM')).toBe(422);
    expect(statusForCode('PAYMENT_METHOD_UNAVAILABLE')).toBe(422);
    expect(statusForCode('NOTHING_DUE')).toBe(409);
  });
});

describe('problemResponse', () => {
  it('emits application/problem+json carrying the stable code', async () => {
    const response = problemResponse({ code: 'PERMISSION_DENIED', details: { permission: 'trip.create' } });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe('application/problem+json');

    const body = await response.json();
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.status).toBe(403);
    expect(body.details).toEqual({ permission: 'trip.create' });
    // The backend never sends text meant to be shown to a person.
    expect(body).not.toHaveProperty('message');
  });
});
