import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    APP_BASE_URL: z.url(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().optional(),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_REGION: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_ADDRESS: z.string().optional(),
    // Optional in every environment, not just development/test: there is no
    // Stripe account anywhere in this phase, so their absence is what
    // selects FakePaymentProvider (see createPaymentProvider), not a
    // misconfiguration to fail fast on the way missing Resend credentials
    // are outside development and test.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PUBLISHABLE_KEY: z.string().optional(),
    // Deliberately a plain optional string, not z.coerce.boolean(): coercion
    // treats any non-empty string (including the literal "false") as true,
    // which is exactly the "on by accident" failure mode this flag must
    // never have. Interpreted explicitly below -- only the literal "true"
    // turns it on; absent or malformed stays off.
    EMAIL_VERBOSE_LOGGING: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_DRIVER === 'local' && !value.STORAGE_LOCAL_ROOT) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_LOCAL_ROOT is required when STORAGE_DRIVER is local' });
    }
    if (value.STORAGE_DRIVER === 's3' && (!value.STORAGE_S3_BUCKET || !value.STORAGE_S3_REGION)) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_S3_BUCKET and STORAGE_S3_REGION are required when STORAGE_DRIVER is s3' });
    }
    // Console email provider is selected for development/test (see createEmail);
    // every other environment sends through Resend and needs its credentials.
    const needsResendCredentials = value.NODE_ENV !== 'development' && value.NODE_ENV !== 'test';
    if (needsResendCredentials && !value.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'RESEND_API_KEY is required when NODE_ENV is not development or test' });
    }
    if (needsResendCredentials && !value.RESEND_FROM_ADDRESS) {
      ctx.addIssue({ code: 'custom', message: 'RESEND_FROM_ADDRESS is required when NODE_ENV is not development or test' });
    }
    // Both or neither: a lone STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is
    // a half-finished configuration that createPaymentProvider cannot act
    // on (it only switches to Stripe once both are present), so catching it
    // here beats silently falling back to the fake while someone believes
    // Stripe is wired up.
    const hasSecretKey = Boolean(value.STRIPE_SECRET_KEY);
    const hasWebhookSecret = Boolean(value.STRIPE_WEBHOOK_SECRET);
    if (hasSecretKey !== hasWebhookSecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set, or both left unset',
      });
    }
  });

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  appBaseUrl: string;
  storageDriver: 'local' | 's3';
  storageLocalRoot?: string;
  storageS3Bucket?: string;
  storageS3Region?: string;
  resendApiKey?: string;
  resendFromAddress?: string;
  /** Optional in every environment -- see `createPaymentProvider`. */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePublishableKey?: string;
  /**
   * Prints email `html`/`text` bodies to the console (ConsoleEmailProvider
   * only). Off by default and off for any value other than the literal
   * "true": Task 11 sends six-digit email-verification codes through this
   * port, and this flag controls whether those land in the log.
   */
  emailVerboseLogging: boolean;
}

export function loadEnv(source: Record<string, string | undefined>): AppEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    jwtSecret: value.JWT_SECRET,
    accessTokenTtlSeconds: value.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: value.REFRESH_TOKEN_TTL_DAYS,
    appBaseUrl: value.APP_BASE_URL,
    storageDriver: value.STORAGE_DRIVER,
    storageLocalRoot: value.STORAGE_LOCAL_ROOT,
    storageS3Bucket: value.STORAGE_S3_BUCKET,
    storageS3Region: value.STORAGE_S3_REGION,
    resendApiKey: value.RESEND_API_KEY,
    resendFromAddress: value.RESEND_FROM_ADDRESS,
    stripeSecretKey: value.STRIPE_SECRET_KEY,
    stripeWebhookSecret: value.STRIPE_WEBHOOK_SECRET,
    stripePublishableKey: value.STRIPE_PUBLISHABLE_KEY,
    emailVerboseLogging: value.EMAIL_VERBOSE_LOGGING === 'true',
  };
}
