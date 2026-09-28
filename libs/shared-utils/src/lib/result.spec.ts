import { describe, expect, it } from 'vitest';
import { fail, ok } from './result';

describe('Result', () => {
  it('wraps a success value', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('wraps a failure with a stable code and details', () => {
    const result = fail('TRIP_SOLD_OUT', { tripId: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TRIP_SOLD_OUT');
      expect(result.error.details).toEqual({ tripId: 'abc' });
    }
  });
});
