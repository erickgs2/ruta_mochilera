import type { Db } from '@rm/db';
import type { NotificationQueue } from '@rm/domain-notifications';
import { creditFromExpiration, type CancelPendingPaymentIntents } from '@rm/domain-payments';
import { expireHolds } from './expire-holds';

/**
 * `expireHolds` as the worker runs it: with the credit of an expired hold's
 * payments injected (decision 16). `expireHolds` takes the hook as an optional
 * parameter so its own suite can run with and without it; this is the one
 * place that composes the production call, so `main.ts` and the E2E fixtures
 * cannot drift apart from it -- and `run-expire-holds.spec.ts` fails if the
 * injection is ever dropped.
 */
export function runExpireHolds(
  db: Db,
  queue: NotificationQueue,
  cancelPendingPaymentIntents?: CancelPendingPaymentIntents
): Promise<void> {
  return expireHolds(db, queue, cancelPendingPaymentIntents, creditFromExpiration);
}
