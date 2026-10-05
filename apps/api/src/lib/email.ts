import { createEmail, type EmailProvider } from '@rm/email';
import { config } from './config';

/**
 * Singleton `EmailProvider` for the route handlers that send mail directly
 * and synchronously (`register`, `resend-code`, `forgot-password`), mirroring
 * `db()` in `./db.ts`. Unlike `apps/worker`'s own `EmailProvider` (used only
 * by `deliverQueuedEmail` for the Task 8 notifications outbox), nothing here
 * goes through pg-boss -- see `@rm/domain-identity`'s `registerCustomer` and
 * `requestPasswordReset` doc comments for why a one-time code or reset token
 * is sent directly instead of through that durable, Postgres-backed queue.
 */
let cached: EmailProvider | undefined;

export function email(): EmailProvider {
  cached ??= createEmail(config());
  return cached;
}

/**
 * Test-only seam, mirroring `setDb`/`setConfig`: lets an integration test
 * substitute a capturing fake for the real `ConsoleEmailProvider` that
 * `createEmail` would otherwise build from `config()`.
 */
export function setEmail(value: EmailProvider | undefined): void {
  cached = value;
}
