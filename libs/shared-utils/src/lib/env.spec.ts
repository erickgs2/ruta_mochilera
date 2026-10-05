import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://rm:rm@localhost:5432/rm_dev',
  JWT_SECRET: 'x'.repeat(32),
  APP_BASE_URL: 'http://localhost:3000',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_ROOT: './storage',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.accessTokenTtlSeconds).toBe(900);
    expect(env.refreshTokenTtlDays).toBe(30);
    expect(env.storageDriver).toBe('local');
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('requires STORAGE_S3_BUCKET when the driver is s3', () => {
    expect(() =>
      loadEnv({ ...valid, STORAGE_DRIVER: 's3', STORAGE_LOCAL_ROOT: undefined })
    ).toThrow(/STORAGE_S3_BUCKET/);
  });

  it('names the offending variable when a stock Zod message is used', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('does not require Resend credentials in development or test', () => {
    const env = loadEnv(valid);
    expect(env.resendApiKey).toBeUndefined();
    expect(env.resendFromAddress).toBeUndefined();
  });

  it('requires RESEND_API_KEY and RESEND_FROM_ADDRESS outside development and test', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
  });

  it('accepts a production environment with Resend credentials configured', () => {
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      RESEND_API_KEY: 'resend-key',
      RESEND_FROM_ADDRESS: 'no-reply@example.com',
    });
    expect(env.resendApiKey).toBe('resend-key');
    expect(env.resendFromAddress).toBe('no-reply@example.com');
  });

  it('defaults EMAIL_VERBOSE_LOGGING to off when absent', () => {
    const env = loadEnv(valid);
    expect(env.emailVerboseLogging).toBe(false);
  });

  it('turns EMAIL_VERBOSE_LOGGING on only for the exact literal "true"', () => {
    const env = loadEnv({ ...valid, EMAIL_VERBOSE_LOGGING: 'true' });
    expect(env.emailVerboseLogging).toBe(true);
  });

  it('keeps EMAIL_VERBOSE_LOGGING off for any malformed value, never throwing', () => {
    const env = loadEnv({ ...valid, EMAIL_VERBOSE_LOGGING: 'yes' });
    expect(env.emailVerboseLogging).toBe(false);
  });

  it('leaves the Stripe credentials undefined when none are configured, in every NODE_ENV', () => {
    const env = loadEnv({ ...valid, NODE_ENV: 'production', RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'a@b.com' });
    expect(env.stripeSecretKey).toBeUndefined();
    expect(env.stripeWebhookSecret).toBeUndefined();
    expect(env.stripePublishableKey).toBeUndefined();
  });

  it('accepts all three Stripe variables once configured', () => {
    const env = loadEnv({
      ...valid,
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
    });
    expect(env.stripeSecretKey).toBe('sk_test_x');
    expect(env.stripeWebhookSecret).toBe('whsec_x');
    expect(env.stripePublishableKey).toBe('pk_test_x');
  });

  it('rejects a lone STRIPE_SECRET_KEY without its matching webhook secret', () => {
    expect(() => loadEnv({ ...valid, STRIPE_SECRET_KEY: 'sk_test_x' })).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('rejects a lone STRIPE_WEBHOOK_SECRET without its matching secret key', () => {
    expect(() => loadEnv({ ...valid, STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('leaves the social login client ids undefined when absent, in every NODE_ENV', () => {
    const env = loadEnv({ ...valid, NODE_ENV: 'production', RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'a@b.com' });
    expect(env.googleOauthClientId).toBeUndefined();
    expect(env.appleOauthClientId).toBeUndefined();
  });

  it('treats an explicitly empty GOOGLE_OAUTH_CLIENT_ID / APPLE_OAUTH_CLIENT_ID the same as absent, never throwing', () => {
    const env = loadEnv({ ...valid, GOOGLE_OAUTH_CLIENT_ID: '', APPLE_OAUTH_CLIENT_ID: '' });
    expect(env.googleOauthClientId).toBe('');
    expect(env.appleOauthClientId).toBe('');
  });

  it('accepts a configured GOOGLE_OAUTH_CLIENT_ID / APPLE_OAUTH_CLIENT_ID', () => {
    const env = loadEnv({ ...valid, GOOGLE_OAUTH_CLIENT_ID: 'google-client-id', APPLE_OAUTH_CLIENT_ID: 'apple-client-id' });
    expect(env.googleOauthClientId).toBe('google-client-id');
    expect(env.appleOauthClientId).toBe('apple-client-id');
  });

  it('defaults corsAllowedOrigins to an empty array when CORS_ALLOWED_ORIGINS is absent', () => {
    const env = loadEnv(valid);
    expect(env.corsAllowedOrigins).toEqual([]);
  });

  it('splits CORS_ALLOWED_ORIGINS on commas and trims whitespace', () => {
    const env = loadEnv({ ...valid, CORS_ALLOWED_ORIGINS: 'capacitor://localhost, https://localhost ,http://localhost:3001' });
    expect(env.corsAllowedOrigins).toEqual(['capacitor://localhost', 'https://localhost', 'http://localhost:3001']);
  });

  it('drops empty entries from CORS_ALLOWED_ORIGINS (trailing comma, blank value)', () => {
    const env = loadEnv({ ...valid, CORS_ALLOWED_ORIGINS: 'capacitor://localhost,,  ,' });
    expect(env.corsAllowedOrigins).toEqual(['capacitor://localhost']);
  });

  it('treats an explicitly empty CORS_ALLOWED_ORIGINS the same as absent', () => {
    const env = loadEnv({ ...valid, CORS_ALLOWED_ORIGINS: '' });
    expect(env.corsAllowedOrigins).toEqual([]);
  });
});
