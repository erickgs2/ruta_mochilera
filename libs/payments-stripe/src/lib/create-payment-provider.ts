import type { AppEnv } from '@rm/shared-utils';
import { FakePaymentProvider } from './fake-payment-provider';
import type { PaymentProvider } from './payment-provider';
import { StripePaymentProvider } from './stripe-payment-provider';

/**
 * Chooses the implementation from the environment, mirroring `@rm/email`'s
 * `createEmail` -- except, unlike Resend, Stripe's credentials are optional
 * in *every* environment, never required outside development and test:
 * there is no Stripe account anywhere in this phase, so their absence is
 * exactly what selects `FakePaymentProvider`, not a misconfiguration to
 * fail fast on. Nothing else in the app branches on which implementation
 * this returns.
 */
export function createPaymentProvider(env: AppEnv): PaymentProvider {
  if (env.stripeSecretKey && env.stripeWebhookSecret) {
    return new StripePaymentProvider(env.stripeSecretKey, env.stripeWebhookSecret);
  }
  return new FakePaymentProvider();
}
