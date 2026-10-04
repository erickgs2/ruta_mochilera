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

/** Every job name in this workspace, for anything that needs to iterate them (e.g. `apps/worker`'s startup). */
export const JOB_NAMES = [
  EXPIRE_HOLDS_JOB,
  WARN_EXPIRING_HOLDS_JOB,
  RECONCILE_PAID_CENTS_JOB,
  SEND_NOTIFICATION_EMAIL_JOB,
] as const;

/** The payload `libs/domain/notifications` sends and `apps/worker` reads back for `SEND_NOTIFICATION_EMAIL_JOB`. */
export interface SendNotificationEmailPayload {
  deliveryId: string;
}
