import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * The environment every E2E process shares: the API under test, the setup
 * that resets the database, and the specs that reach into it.
 *
 * Deterministic on purpose (Task 21, step 2):
 * - its own database, `rm_e2e`, rebuilt from the migrations before each run,
 *   never the developer's `rm_dev`;
 * - its own ports, so a developer's `nx dev api` / `nx serve client` on
 *   3000/4201 never answers in place of the build under test;
 * - the Stripe keys blanked, which makes `createPaymentProvider` pick the
 *   in-memory `FakePaymentProvider`: no run depends on Stripe being up. The
 *   specs confirm payments by sending the webhook Stripe would send, signed
 *   with the fake's secret -- the same code path a real payment takes.
 */
export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

loadDotenv({ path: resolve(WORKSPACE_ROOT, '.env'), quiet: true });

export const API_PORT = Number(process.env['E2E_API_PORT'] ?? 3100);
export const CLIENT_PORT = Number(process.env['E2E_CLIENT_PORT'] ?? 4300);
export const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;

/** The fake provider's default webhook secret (`FakePaymentProvider`'s constructor). */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';

export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://rm:rm@localhost:5432/rm_e2e';

/** Variables every child process gets on top of the developer's `.env`. */
export function e2eProcessEnv(): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return {
    ...inherited,
    NODE_ENV: 'development',
    DATABASE_URL: E2E_DATABASE_URL,
    APP_BASE_URL: API_URL,
    CLIENT_APP_URL: CLIENT_URL,
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PUBLISHABLE_KEY: '',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: resolve(WORKSPACE_ROOT, 'tmp/e2e-storage'),
  };
}
