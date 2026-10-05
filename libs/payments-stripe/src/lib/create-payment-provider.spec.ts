import type { AppEnv } from '@rm/shared-utils';
import { describe, expect, it } from 'vitest';
import { createPaymentProvider } from './create-payment-provider';
import { FakePaymentProvider } from './fake-payment-provider';
import { StripePaymentProvider } from './stripe-payment-provider';

const baseEnv: AppEnv = {
  nodeEnv: 'development',
  databaseUrl: 'postgresql://rm:rm@localhost:5432/rm_dev',
  jwtSecret: 'x'.repeat(32),
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  appBaseUrl: 'http://localhost:3000',
  storageDriver: 'local',
  storageLocalRoot: './storage',
  emailVerboseLogging: false,
  corsAllowedOrigins: [],
};

describe('createPaymentProvider', () => {
  it('builds the fake provider when no Stripe credentials are configured, in every environment', () => {
    expect(createPaymentProvider(baseEnv)).toBeInstanceOf(FakePaymentProvider);
    expect(createPaymentProvider({ ...baseEnv, nodeEnv: 'production' })).toBeInstanceOf(FakePaymentProvider);
  });

  it('builds the Stripe provider once both credentials are present', () => {
    const provider = createPaymentProvider({
      ...baseEnv,
      stripeSecretKey: 'sk_test_x',
      stripeWebhookSecret: 'whsec_x',
    });

    expect(provider).toBeInstanceOf(StripePaymentProvider);
  });

  it('builds the fake provider when only one of the two Stripe credentials is present', () => {
    expect(createPaymentProvider({ ...baseEnv, stripeSecretKey: 'sk_test_x' })).toBeInstanceOf(FakePaymentProvider);
    expect(createPaymentProvider({ ...baseEnv, stripeWebhookSecret: 'whsec_x' })).toBeInstanceOf(
      FakePaymentProvider
    );
  });
});
