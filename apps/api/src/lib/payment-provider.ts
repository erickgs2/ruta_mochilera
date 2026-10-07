import { createPaymentProvider, type PaymentProvider } from '@rm/payments-stripe';
import { config } from './config';

let cached: PaymentProvider | undefined;

/**
 * The payment provider every route handler resolves through, chosen from
 * the environment by `createPaymentProvider`: the real Stripe adapter once
 * `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both set, and
 * `FakePaymentProvider` otherwise. Same lazy-singleton shape as `db()`,
 * `config()` and `storage()`.
 */
export function paymentProvider(): PaymentProvider {
  cached ??= createPaymentProvider(config());
  return cached;
}

/**
 * Test-only seam, mirroring `setDb` and `setStorage`: overrides the
 * singleton the webhook route resolves through.
 *
 * The webhook suite needs a provider whose webhook signatures it can
 * actually produce (`FakePaymentProvider.signWebhookPayload`), and one that
 * can be made to blow up on demand so the route's 502 mapping is exercised
 * rather than assumed.
 */
export function setPaymentProvider(provider: PaymentProvider | undefined): void {
  cached = provider;
}
