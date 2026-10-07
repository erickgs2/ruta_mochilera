import { createHmac, randomUUID } from 'node:crypto';
import { fail, ok, type Result } from '@rm/shared-utils';
import {
  isValidAmountCents,
  isValidCustomerEmail,
  parseStripeEventBody,
  PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID,
  PROVIDER_REJECTED_TEST_RESERVATION_ID,
  timingSafeEqualStrings,
  type PaymentIntentRequest,
  type PaymentIntentResult,
  type PaymentProvider,
  type WebhookEvent,
} from './payment-provider';

type FakeIntentStatus = 'pending' | 'canceled';

interface FakeIntent {
  reservationId: string;
  amountCents: number;
  method: PaymentIntentRequest['method'];
  status: FakeIntentStatus;
  voucherExpiresAt?: Date;
  failCancel: boolean;
}

/**
 * A real implementation of `PaymentProvider` that lives in `libs/`, not a
 * loose test mock -- it is exercised by the exact same contract
 * (`runPaymentContract`) that a real Stripe implementation would be, and it
 * is what lets Tasks 10 through 17 build and test the whole
 * reservation-and-payment flow without any Stripe account or API key.
 *
 * State is in-memory and per-instance, same as `ConsoleEmailProvider`: there
 * is no persistence across process restarts, which is fine, because nothing
 * in this phase expects a payment provider's own bookkeeping to survive a
 * restart -- the `Payment` row in Postgres is the durable record.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly intents = new Map<string, FakeIntent>();

  constructor(private readonly webhookSecret: string = 'fake-webhook-secret') {}

  async createIntent(request: PaymentIntentRequest): Promise<Result<PaymentIntentResult>> {
    if (!isValidAmountCents(request.amountCents)) {
      return fail('VALIDATION_FAILED', { field: 'amountCents' });
    }
    if (!isValidCustomerEmail(request.customerEmail)) {
      return fail('VALIDATION_FAILED', { field: 'customerEmail' });
    }
    if (request.method === 'OXXO' && !request.voucherExpiresAt) {
      return fail('VALIDATION_FAILED', { field: 'voucherExpiresAt' });
    }
    if (request.reservationId === PROVIDER_REJECTED_TEST_RESERVATION_ID) {
      return fail('PAYMENT_PROVIDER_ERROR', { reason: 'simulated_provider_rejection' });
    }

    const providerIntentId = `fake-intent-${randomUUID()}`;
    this.intents.set(providerIntentId, {
      reservationId: request.reservationId,
      amountCents: request.amountCents,
      method: request.method,
      status: 'pending',
      voucherExpiresAt: request.voucherExpiresAt,
      failCancel: request.reservationId === PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID,
    });

    const result: PaymentIntentResult = {
      providerIntentId,
      clientSecret: `fake-secret-${providerIntentId}`,
    };
    if (request.method === 'OXXO') {
      result.voucherUrl = `https://fake-oxxo.test/vouchers/${providerIntentId}`;
      result.voucherExpiresAt = request.voucherExpiresAt;
    }
    return ok(result);
  }

  async cancelIntent(providerIntentId: string): Promise<Result<null>> {
    const intent = this.intents.get(providerIntentId);
    if (!intent) {
      return fail('NOT_FOUND', { field: 'providerIntentId' });
    }
    if (intent.failCancel) {
      return fail('PAYMENT_PROVIDER_ERROR', { reason: 'simulated_provider_rejection' });
    }

    // Idempotent: cancelling an intent that is already `canceled` just
    // writes the same status again and still answers ok(null).
    intent.status = 'canceled';
    return ok(null);
  }

  verifyWebhook(payload: string, signature: string): Result<WebhookEvent> {
    const expected = this.signWebhookPayload(payload);
    if (!timingSafeEqualStrings(signature, expected)) {
      return fail('VALIDATION_FAILED', { reason: 'invalid_signature' });
    }

    // The body is parsed by the exact same `parseStripeEventBody` the Stripe
    // adapter uses, over Stripe's own event shape: the fake differs from the
    // real provider in how a signature is computed and in nothing else, so a
    // test driving this fake exercises the real parsing.
    return parseStripeEventBody(payload);
  }

  /**
   * Test-support only, not part of the `PaymentProvider` port: produces a
   * signature `verifyWebhook` accepts for this exact payload, so a test (or
   * a local dev script simulating an incoming webhook) can build a valid
   * request against this fake without needing Stripe's own signing scheme.
   */
  signWebhookPayload(payload: string): string {
    return createHmac('sha256', this.webhookSecret).update(payload, 'utf8').digest('hex');
  }

  /**
   * Test-support only, not part of the `PaymentProvider` port: lets a test
   * assert on an intent's current state after calling `cancelIntent`
   * through the port, the way `expire-holds.spec.ts` needs to.
   */
  inspect(providerIntentId: string): { status: FakeIntentStatus } | undefined {
    const intent = this.intents.get(providerIntentId);
    return intent ? { status: intent.status } : undefined;
  }
}
