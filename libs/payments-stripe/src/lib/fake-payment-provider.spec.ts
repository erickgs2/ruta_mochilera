import { describe, expect, it } from 'vitest';
import { runPaymentContract } from '../testing/payment-contract';
import { FakePaymentProvider } from './fake-payment-provider';

runPaymentContract('fake', async () => new FakePaymentProvider());

describe('FakePaymentProvider', () => {
  it('accepts a correctly signed webhook payload and parses its event', () => {
    const provider = new FakePaymentProvider();
    const payload = JSON.stringify({
      type: 'payment_intent.succeeded',
      providerIntentId: 'fake-intent-123',
      occurredAt: '2026-10-04T00:00:00.000Z',
    });
    const signature = provider.signWebhookPayload(payload);

    const result = provider.verifyWebhook(payload, signature);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('payment_intent.succeeded');
      expect(result.value.providerIntentId).toBe('fake-intent-123');
      expect(result.value.occurredAt).toEqual(new Date('2026-10-04T00:00:00.000Z'));
    }
  });

  it('returns a VALIDATION_FAILED Result, never a thrown exception, for a well-signed but malformed payload', () => {
    const provider = new FakePaymentProvider();
    const payload = 'not-json';
    const signature = provider.signWebhookPayload(payload);

    const result = provider.verifyWebhook(payload, signature);

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('returns a NOT_FOUND Result, never a thrown exception, when cancelling an intent id that was never created', async () => {
    const provider = new FakePaymentProvider();

    await expect(provider.cancelIntent('does-not-exist')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('exposes an intent as pending until it is cancelled', async () => {
    const provider = new FakePaymentProvider();
    const created = await provider.createIntent({
      reservationId: 'reservation-inspect',
      amountCents: 50_000,
      method: 'CARD',
      customerEmail: 'traveler@example.com',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(provider.inspect(created.value.providerIntentId)).toEqual({ status: 'pending' });

    await provider.cancelIntent(created.value.providerIntentId);

    expect(provider.inspect(created.value.providerIntentId)).toEqual({ status: 'canceled' });
  });

  it('returns a VALIDATION_FAILED Result, never a thrown exception, for a non-positive amount', async () => {
    const provider = new FakePaymentProvider();

    await expect(
      provider.createIntent({
        reservationId: 'reservation-bad-amount',
        amountCents: 0,
        method: 'CARD',
        customerEmail: 'traveler@example.com',
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'amountCents' } } });
  });

  it('returns a VALIDATION_FAILED Result, never a thrown exception, for a malformed customer email', async () => {
    const provider = new FakePaymentProvider();

    await expect(
      provider.createIntent({
        reservationId: 'reservation-bad-email',
        amountCents: 100_000,
        method: 'CARD',
        customerEmail: 'not-an-email',
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'customerEmail' } } });
  });
});
