import { describe, expect, it } from 'vitest';
import { oxxoExpiresAfterDays, StripePaymentProvider } from './stripe-payment-provider';

/**
 * Deliberately narrow, unlike every other `.spec.ts` in this library:
 * `StripePaymentProvider` as a whole stays typechecked-only (no Stripe
 * account or API key in this environment -- see the library README and the
 * Task 9 report). But `oxxoExpiresAfterDays` is a pure function of two
 * `Date`s, and `createIntent`'s OXXO-window check runs and returns before
 * it ever calls `fetch`, so both are fully exercisable with no network and
 * no credentials. A Task 9 review round found a real bug in exactly this
 * pure function that a test here would have caught (round 1, Critical: the
 * old clamp let a sub-24-hour window ask Stripe for the one-day minimum
 * anyway, letting the voucher outlive the hold) -- these tests exist to
 * make sure it cannot reappear silently.
 */
describe('oxxoExpiresAfterDays', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const HOUR_MS = 60 * 60 * 1000;

  it('floors a window well over a day to the whole number of days remaining', () => {
    // 72h -> exactly 3 days, nothing to floor away.
    const voucherExpiresAt = new Date(now.getTime() + 72 * HOUR_MS);
    expect(oxxoExpiresAfterDays(voucherExpiresAt, now)).toBe(3);
  });

  it('returns 1 for a window of exactly one day', () => {
    const voucherExpiresAt = new Date(now.getTime() + 24 * HOUR_MS);
    expect(oxxoExpiresAfterDays(voucherExpiresAt, now)).toBe(1);
  });

  it('refuses (returns undefined) a window just under one day, rather than clamping it up to 1', () => {
    // The Critical bug this guards against: the old code clamped this case
    // up to 1 day, which asks Stripe to keep an OXXO voucher alive longer
    // than a hold shorter than 24h (hold_ttl_hours is configurable per
    // trip and the business-rules docs use a 6-hour hold as a worked
    // example) -- letting the system confirm a payment for a seat it had
    // already released back into inventory (business rule 5.3).
    const voucherExpiresAt = new Date(now.getTime() + 23 * HOUR_MS + 59 * 60 * 1000);
    expect(oxxoExpiresAfterDays(voucherExpiresAt, now)).toBeUndefined();
  });

  it('refuses a window that has already passed or is exactly now', () => {
    expect(oxxoExpiresAfterDays(now, now)).toBeUndefined();
    expect(oxxoExpiresAfterDays(new Date(now.getTime() - HOUR_MS), now)).toBeUndefined();
  });

  it('clamps a window far beyond the documented ceiling to 31 days', () => {
    const voucherExpiresAt = new Date(now.getTime() + 400 * 24 * HOUR_MS);
    expect(oxxoExpiresAfterDays(voucherExpiresAt, now)).toBe(31);
  });

  it('returns exactly 31 for a window of exactly 31 days, the ceiling itself', () => {
    const voucherExpiresAt = new Date(now.getTime() + 31 * 24 * HOUR_MS);
    expect(oxxoExpiresAfterDays(voucherExpiresAt, now)).toBe(31);
  });
});

describe('StripePaymentProvider.createIntent OXXO window refusal', () => {
  // No network call is reached by any case here: the refusal below returns
  // before `fetch` is ever invoked, which is exactly what makes this
  // provider -- otherwise untestable without a Stripe account -- safe to
  // exercise directly.
  const provider = new StripePaymentProvider('sk_test_unused', 'whsec_unused');

  it('returns VALIDATION_FAILED, never a thrown exception, for an OXXO request whose window is under a day', async () => {
    const voucherExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes out

    await expect(
      provider.createIntent({
        reservationId: 'reservation-short-hold',
        amountCents: 100_000,
        method: 'OXXO',
        customerEmail: 'traveler@example.com',
        voucherExpiresAt,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'voucherExpiresAt', reason: 'window_too_short_for_oxxo' } },
    });
  });
});
