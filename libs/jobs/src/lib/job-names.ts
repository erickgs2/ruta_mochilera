/**
 * The queue names every job in this workspace is sent and worked under.
 *
 * Shared between the two sides that must agree on them without depending on
 * each other: `libs/domain/notifications` (which enqueues
 * `SEND_NOTIFICATION_EMAIL_JOB` inside the caller's own transaction, see
 * Ruling 11 in `docs/business-rules/notifications.md`) and `apps/worker`
 * (which registers a handler for every name here, including the three
 * Task 8 cadence jobs). Neither side imports pg-boss from here -- this
 * library only names things, as plain strings, so a producer can name a job
 * without pulling in the queue runtime.
 *
 * Literal values match the Task 8 brief exactly for the three cadence jobs.
 */
export const EXPIRE_HOLDS_JOB = 'expire-holds';
export const WARN_EXPIRING_HOLDS_JOB = 'warn-expiring-holds';
export const RECONCILE_PAID_CENTS_JOB = 'reconcile-paid-cents';

/**
 * The outbox job Ruling 11 introduces: `libs/domain/notifications` enqueues
 * one of these per `EMAIL`-channel `NotificationDelivery` row, inside the
 * same transaction that writes the row, so a rollback removes both. The
 * worker's handler is the only thing that ever calls `EmailProvider.send`.
 */
export const SEND_NOTIFICATION_EMAIL_JOB = 'send-notification-email';

/**
 * Phase 2B: generates a payment's receipt PDF if it does not exist yet,
 * stores it and emails it to the customer. Enqueued by `@rm/domain-payments`
 * in the same transaction that leaves the payment SUCCEEDED (same outbox
 * pattern as above), or by staff asking to resend one.
 */
export const SEND_RECEIPT_JOB = 'send-receipt';

/**
 * Phase 2B: applies a validated CSV import, row by row. Enqueued by
 * `@rm/domain-imports` in the same transaction that claims the batch
 * (VALIDATED -> APPLYING); a request would time out on 5,000 rows.
 */
export const APPLY_IMPORT_JOB = 'apply-import';

/** Every job name in this workspace, for anything that needs to iterate them (e.g. `apps/worker`'s startup). */
export const JOB_NAMES = [
  EXPIRE_HOLDS_JOB,
  WARN_EXPIRING_HOLDS_JOB,
  RECONCILE_PAID_CENTS_JOB,
  SEND_NOTIFICATION_EMAIL_JOB,
  SEND_RECEIPT_JOB,
  APPLY_IMPORT_JOB,
] as const;

/** The payload `libs/domain/notifications` sends and `apps/worker` reads back for `SEND_NOTIFICATION_EMAIL_JOB`. */
export interface SendNotificationEmailPayload {
  deliveryId: string;
}

/** The payload `@rm/domain-payments` sends and `apps/worker` reads back for `SEND_RECEIPT_JOB`. */
export interface SendReceiptPayload {
  paymentId: string;
  /** Staff asked to send it again: send even if `receipt_sent_at` is already set. */
  resend?: boolean;
}

/** The payload `@rm/domain-imports` sends and `apps/worker` reads back for `APPLY_IMPORT_JOB`. */
export interface ApplyImportPayload {
  batchId: string;
  actorId: string;
}
