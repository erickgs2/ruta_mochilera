import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRateLimit,
  isRateLimited,
  recordFailedAttempt,
  resetRateLimiterForTesting,
} from './rate-limiter';

describe('rate limiter', () => {
  beforeEach(() => {
    resetRateLimiterForTesting();
  });

  it('is not limited before any failure is recorded', () => {
    expect(isRateLimited('register', 'a@example.com', '10.0.0.1')).toBe(false);
  });

  it('trips after five failures against the same email within one scope', () => {
    for (let i = 0; i < 5; i += 1) recordFailedAttempt('register', 'a@example.com', `10.0.0.${i}`);
    expect(isRateLimited('register', 'a@example.com', '10.0.0.99')).toBe(true);
  });

  it('trips after five failures from the same IP, even against different emails', () => {
    for (let i = 0; i < 5; i += 1) recordFailedAttempt('forgot-password', `u${i}@example.com`, '203.0.113.5');
    expect(isRateLimited('forgot-password', 'someone-else@example.com', '203.0.113.5')).toBe(true);
  });

  it('keeps one scope from tripping another: exhausting register does not limit login for the same email/ip', () => {
    for (let i = 0; i < 5; i += 1) recordFailedAttempt('register', 'shared@example.com', '10.0.0.1');
    expect(isRateLimited('register', 'shared@example.com', '10.0.0.1')).toBe(true);
    expect(isRateLimited('login', 'shared@example.com', '10.0.0.1')).toBe(false);
  });

  it('expires the window after WINDOW_MS', () => {
    const start = 1_000_000;
    for (let i = 0; i < 5; i += 1) recordFailedAttempt('verify-email', 'a@example.com', '10.0.0.1', start);
    expect(isRateLimited('verify-email', 'a@example.com', '10.0.0.1', start + 1000)).toBe(true);
    expect(isRateLimited('verify-email', 'a@example.com', '10.0.0.1', start + 16 * 60 * 1000)).toBe(false);
  });

  it('clearRateLimit resets both counters for its scope', () => {
    for (let i = 0; i < 5; i += 1) recordFailedAttempt('resend-code', 'a@example.com', '10.0.0.1');
    clearRateLimit('resend-code', 'a@example.com', '10.0.0.1');
    expect(isRateLimited('resend-code', 'a@example.com', '10.0.0.1')).toBe(false);
  });
});
