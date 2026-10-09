import { describe, expect, it } from 'vitest';
import { runPaymentContract } from '../testing/payment-contract';
import { FakePaymentProvider } from './fake-payment-provider';
import { OXXO_VOUCHER_EXPIRED_FAILURE_CODE } from './payment-provider';

runPaymentContract('fake', async () => new FakePaymentProvider());

/**
 * A Stripe `payment_intent.*` event body, in the shape Stripe itself
 * delivers. `FakePaymentProvider` and `StripePaymentProvider` share one
 * parser (`parseStripeEventBody`) and differ only in how the signature is
 * computed, so a payload built here exercises the same parsing the real
 * adapter does.
 */
function paymentIntentEvent(overrides: Record<string, unknown> = {}): string {
  const { object = {}, ...event } = overrides as { object?: Record<string, unknown> };
  return JSON.stringify({
    id: 'evt_test_1',
    type: 'payment_intent.succeeded',
    created: 1_790_000_000,
    data: {
      object: {
        id: 'pi_test_1',
        amount: 150_000,
        currency: 'mxn',
        payment_method_types: ['card'],
        metadata: { reservationId: '11111111-1111-4111-8111-111111111111' },
        ...object,
      },
    },
    ...event,
  });
}

describe('FakePaymentProvider', () => {
  it('accepts a correctly signed webhook payload and parses its event', () => {
    const provider = new FakePaymentProvider();
    const payload = paymentIntentEvent();
    const signature = provider.signWebhookPayload(payload);

    const result = provider.verifyWebhook(payload, signature);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('payment_intent.succeeded');
      expect(result.value.intent?.providerIntentId).toBe('pi_test_1');
      expect(result.value.occurredAt).toEqual(new Date(1_790_000_000 * 1000));
    }
  });

  it("carries Stripe's own event id, which is what makes the webhook idempotent", () => {
    const provider = new FakePaymentProvider();
    const payload = paymentIntentEvent({ id: 'evt_idempotency' });

    const result = provider.verifyWebhook(payload, provider.signWebhookPayload(payload));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('evt_idempotency');
  });

  it('carries the whole event body, which is what the stripe_events row stores', () => {
    const provider = new FakePaymentProvider();
    const payload = paymentIntentEvent();

    const result = provider.verifyWebhook(payload, provider.signWebhookPayload(payload));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload).toEqual(JSON.parse(payload));
  });

  it('carries the amount, method and reservation the intent was created with', () => {
    // Without these the webhook can only transition a payment row it already
    // has. A `payment_intent.succeeded` for an intent whose PENDING row was
    // never committed would leave money Stripe took with no row at all --
    // the inherited Task 5 finding this widening exists to close.
    const provider = new FakePaymentProvider();
    const payload = paymentIntentEvent({
      object: { amount: 240_000, payment_method_types: ['oxxo'], metadata: { reservationId: 'res-42' } },
    });

    const result = provider.verifyWebhook(payload, provider.signWebhookPayload(payload));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent).toMatchObject({
        providerIntentId: 'pi_test_1',
        amountCents: 240_000,
        method: 'OXXO',
        reservationId: 'res-42',
      });
    }
  });

  it('carries the failure code that tells an expired OXXO voucher apart from a declined card', () => {
    const provider = new FakePaymentProvider();
    const payload = paymentIntentEvent({
      type: 'payment_intent.payment_failed',
      object: { last_payment_error: { code: 'payment_intent_payment_attempt_expired' } },
    });

    const result = provider.verifyWebhook(payload, provider.signWebhookPayload(payload));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.intent?.failureCode).toBe(OXXO_VOUCHER_EXPIRED_FAILURE_CODE);
  });

  it('parses an event type this system does not act on instead of rejecting it', () => {
    // Stripe retries on any non-2xx, so an event we do not care about must
    // never come back as an error: the port hands it over verbatim and
    // `handleStripeEvent` ignores it.
    const provider = new FakePaymentProvider();
    const payload = JSON.stringify({ id: 'evt_other', type: 'customer.created', created: 1_790_000_000, data: { object: { id: 'cus_1' } } });

    const result = provider.verifyWebhook(payload, provider.signWebhookPayload(payload));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('customer.created');
      expect(result.value.intent).toBeUndefined();
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

describe('FakePaymentProvider test support', () => {
  it('uses Stripe\'s documented limits unless a test overrides one method', () => {
    const provider = new FakePaymentProvider(undefined, { OXXO: { minCents: 1_000, maxCents: 100_000 } });
    expect(provider.limitsFor('OXXO')).toEqual({ minCents: 1_000, maxCents: 100_000 });
    expect(provider.limitsFor('CARD')).toEqual({ minCents: 1_000, maxCents: null });
  });

  it('lists the intents cancelled through the port, in order', async () => {
    const provider = new FakePaymentProvider();
    const create = () =>
      provider.createIntent({ reservationId: 'r', amountCents: 10_000, method: 'CARD', customerEmail: 'a@b.co' });
    const first = await create();
    const second = await create();
    if (!first.ok || !second.ok) throw new Error('create failed');

    await provider.cancelIntent(second.value.providerIntentId);
    await provider.cancelIntent(first.value.providerIntentId);
    await provider.cancelIntent(first.value.providerIntentId);

    expect(provider.cancelledIntentIds()).toEqual([second.value.providerIntentId, first.value.providerIntentId]);
  });
});
