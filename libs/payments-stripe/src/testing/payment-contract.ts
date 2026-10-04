import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID,
  PROVIDER_REJECTED_TEST_RESERVATION_ID,
  type PaymentProvider,
} from '../lib/payment-provider';

/**
 * Behaviour every `PaymentProvider` must satisfy, run against each
 * implementation so the fake and Stripe can never quietly drift apart --
 * the same role `@rm/email`'s `runEmailContract` plays for
 * `ConsoleEmailProvider` and `ResendEmailProvider`.
 *
 * Covers exactly what Task 9's brief asks for: creating an intent for each
 * of the three payment methods, cancelling a pending intent, cancelling an
 * already-cancelled intent (idempotent, not an error), and rejecting an
 * invalid webhook signature. On top of that minimum it also exercises the
 * split Ruling 10 established for `@rm/email` (Task 6) and which Task 9
 * carries over for payments: a malformed input is the caller's fault and
 * comes back `VALIDATION_FAILED` (422); a provider or network failure is
 * ours (or Stripe's) and comes back `PAYMENT_PROVIDER_ERROR` (502).
 *
 * Coverage note for the next reader, matching Task 6's own note on
 * `ResendEmailProvider`: as of Task 9 this contract is run only against
 * `FakePaymentProvider` (see `fake-payment-provider.spec.ts`), which
 * exercises every mode below, including both simulated provider-rejection
 * sentinels (`PROVIDER_REJECTED_TEST_RESERVATION_ID` for a failed create,
 * `PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID` for a failed cancel).
 * `StripePaymentProvider` has no Stripe account or API key in this
 * environment -- it is typechecked only, and this suite has never run
 * against it. Do not read a green run of this suite as proof that the
 * Stripe adapter's HTTP calls, its error mapping, or its OXXO voucher
 * handling have ever actually executed.
 */
export function runPaymentContract(name: string, factory: () => Promise<PaymentProvider>): void {
  describe(`${name} payment contract`, () => {
    it('creates a CARD intent', async () => {
      const provider = await factory();

      const result = await provider.createIntent({
        reservationId: 'reservation-card',
        amountCents: 150_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.providerIntentId).toBe('string');
        expect(result.value.providerIntentId.length).toBeGreaterThan(0);
        expect(typeof result.value.clientSecret).toBe('string');
      }
    });

    it('creates an OXXO intent carrying the requested voucher expiry', async () => {
      const provider = await factory();
      // Stands in for the reservation's own `holdExpiresAt` (business rule
      // 5.3): the voucher must never outlive the hold it is paying for.
      const voucherExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

      const result = await provider.createIntent({
        reservationId: 'reservation-oxxo',
        amountCents: 100_000,
        method: 'OXXO',
        customerEmail: 'traveler@example.com',
        voucherExpiresAt,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.voucherUrl).toBeTruthy();
        expect(result.value.voucherExpiresAt).toEqual(voucherExpiresAt);
      }
    });

    it('creates a SPEI intent', async () => {
      const provider = await factory();

      const result = await provider.createIntent({
        reservationId: 'reservation-spei',
        amountCents: 200_000,
        method: 'SPEI',
        customerEmail: 'traveler@example.com',
      });

      expect(result.ok).toBe(true);
    });

    it('returns a VALIDATION_FAILED Result, never a thrown exception, for an OXXO request missing its voucher expiry', async () => {
      // This is the caller's bug (every real call site passes the
      // reservation's holdExpiresAt), not the provider's, so it is the 422
      // code and not PAYMENT_PROVIDER_ERROR.
      const provider = await factory();

      await expect(
        provider.createIntent({
          reservationId: 'reservation-oxxo-missing-expiry',
          amountCents: 100_000,
          method: 'OXXO',
          customerEmail: 'traveler@example.com',
        })
      ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it('returns a PAYMENT_PROVIDER_ERROR Result, never a thrown exception, when the provider rejects the create', async () => {
      // This is the provider's (or the network's) fault, not the caller's,
      // so it maps to the 502 code instead of VALIDATION_FAILED.
      const provider = await factory();

      await expect(
        provider.createIntent({
          reservationId: PROVIDER_REJECTED_TEST_RESERVATION_ID,
          amountCents: 100_000,
          method: 'CARD',
          customerEmail: 'traveler@example.com',
        })
      ).resolves.toMatchObject({ ok: false, error: { code: 'PAYMENT_PROVIDER_ERROR' } });
    });

    it('cancels a pending intent', async () => {
      const provider = await factory();
      const created = await provider.createIntent({
        reservationId: 'reservation-to-cancel',
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const cancelled = await provider.cancelIntent(created.value.providerIntentId);

      expect(cancelled).toMatchObject({ ok: true, value: null });
    });

    it('cancelling an already-cancelled intent is idempotent, not an error', async () => {
      const provider = await factory();
      const created = await provider.createIntent({
        reservationId: 'reservation-double-cancel',
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const first = await provider.cancelIntent(created.value.providerIntentId);
      const second = await provider.cancelIntent(created.value.providerIntentId);

      expect(first).toMatchObject({ ok: true, value: null });
      expect(second).toMatchObject({ ok: true, value: null });
    });

    it('returns a PAYMENT_PROVIDER_ERROR Result, never a thrown exception, when the provider rejects a cancel', async () => {
      const provider = await factory();
      const created = await provider.createIntent({
        reservationId: PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID,
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const cancelled = await provider.cancelIntent(created.value.providerIntentId);

      expect(cancelled).toMatchObject({ ok: false, error: { code: 'PAYMENT_PROVIDER_ERROR' } });
    });

    it('returns a VALIDATION_FAILED Result, never a thrown exception, for an invalid webhook signature', async () => {
      const provider = await factory();

      const result = provider.verifyWebhook(
        '{"type":"payment_intent.succeeded"}',
        'not-a-valid-signature'
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });
  });
}
