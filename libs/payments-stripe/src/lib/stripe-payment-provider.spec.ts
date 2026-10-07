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
  // Stripe's own rule: `expires_after_days = N` makes the voucher expire at
  // 23:59 America/Mexico_City on the Nth calendar day after creation -- not
  // N x 24h later. The voucher must never outlive the hold (rule 5.3), so the
  // answer is the largest N whose end of day is still no later than it.
  const HOUR_MS = 60 * 60 * 1000;
  // Monday 2026-01-05 01:00 in Mexico City (UTC-6).
  const now = new Date('2026-01-05T07:00:00.000Z');

  it('stops at the last calendar day that ends before the hold does, never past it', () => {
    // Hold ends Tuesday 13:00 MX (36h). N = 1 would expire the voucher at
    // 23:59 Tuesday, ~11h after the seat was released -- the bug. Monday
    // ends at 23:59 Monday, but N must be at least 1, so no OXXO here.
    const holdEnds = new Date(now.getTime() + 36 * HOUR_MS);
    expect(oxxoExpiresAfterDays(holdEnds, now)).toBeUndefined();
  });

  it('gives N = 1 when the hold outlasts the end of the next calendar day', () => {
    // Hold ends Wednesday 10:00 MX: the voucher may live until 23:59 Tuesday.
    const holdEnds = new Date('2026-01-07T16:00:00.000Z');
    expect(oxxoExpiresAfterDays(holdEnds, now)).toBe(1);
  });

  it('stops a 72-hour hold ending mid-day at the day before, and allows the day itself when the hold ends at 23:59', () => {
    // Thursday 01:00 MX -> the last whole day before it ends is Wednesday.
    const holdEnds = new Date(now.getTime() + 72 * HOUR_MS);
    expect(oxxoExpiresAfterDays(holdEnds, now)).toBe(2);
    // Ending exactly at 23:59:59.999 Thursday MX allows Thursday itself.
    expect(oxxoExpiresAfterDays(new Date('2026-01-09T05:59:59.999Z'), now)).toBe(3);
  });

  it('refuses a window that has already passed or is exactly now', () => {
    expect(oxxoExpiresAfterDays(now, now)).toBeUndefined();
    expect(oxxoExpiresAfterDays(new Date(now.getTime() - HOUR_MS), now)).toBeUndefined();
  });

  it('counts calendar days in Mexico City, not in UTC', () => {
    // 23:30 Monday MX is already Tuesday in UTC. A hold ending Wednesday
    // 12:00 MX allows the voucher to live until 23:59 Tuesday MX: N = 1.
    const lateMonday = new Date('2026-01-06T05:30:00.000Z');
    expect(oxxoExpiresAfterDays(new Date('2026-01-07T18:00:00.000Z'), lateMonday)).toBe(1);
  });

  it('clamps a window far beyond the documented ceiling to 31 days', () => {
    const holdEnds = new Date(now.getTime() + 400 * 24 * HOUR_MS);
    expect(oxxoExpiresAfterDays(holdEnds, now)).toBe(31);
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
