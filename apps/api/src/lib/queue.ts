import { APPLY_IMPORT_JOB, SEND_NOTIFICATION_EMAIL_JOB, SEND_RECEIPT_JOB } from '@rm/jobs';
import type { NotificationQueue } from '@rm/domain-notifications';
import { PgBoss } from 'pg-boss';
import { config } from './config';

// Next.js hot-reloads modules in development; the instance is cached on
// `globalThis` so a reload does not leave a second pg-boss holding a pool.
const globalForQueue = globalThis as unknown as { rmQueue?: Promise<NotificationQueue> };

/**
 * The job queue `notifyCustomer` / `notifyAdmins` enqueue their email sends
 * on (Ruling 11: the send is written inside the caller's own transaction,
 * so a rollback takes it with it).
 *
 * Asynchronous, unlike `db()`: pg-boss resolves a queue's row before it can
 * insert a job, which it cannot do until `start()` has run.
 *
 * **This instance only ever produces.** `supervise` and `schedule` are off:
 * maintenance, scheduling and every `work` handler belong to `apps/worker`,
 * which is a separate process precisely so a Next.js redeploy cannot kill a
 * job mid-flight. The one queue this process sends to is created here as
 * well (`createQueue` is idempotent) so an API that comes up before the
 * worker ever has can still enqueue.
 */
export function queue(): Promise<NotificationQueue> {
  globalForQueue.rmQueue ??= startQueue();
  return globalForQueue.rmQueue;
}

async function startQueue(): Promise<NotificationQueue> {
  // No explicit `schema`: pg-boss's own default (`pgboss`) sits next to
  // Prisma's (`public`), the same separation `apps/worker` and the test
  // harness both keep.
  const boss = new PgBoss({ connectionString: config().databaseUrl, supervise: false, schedule: false });
  // Background errors arrive on this emitter; unhandled, an `error` event
  // takes the process down.
  boss.on('error', (error) => console.error('[api] pg-boss error', error));
  await boss.start();
  // Every queue this process sends to: notices and, since Phase 2B, receipts
  // and import batches.
  await boss.createQueue(SEND_NOTIFICATION_EMAIL_JOB);
  await boss.createQueue(SEND_RECEIPT_JOB);
  await boss.createQueue(APPLY_IMPORT_JOB);
  return boss;
}

/**
 * Test-only seam, mirroring `setDb`: points the singleton at the suite's
 * own isolated queue (`@rm/jobs/testing`'s `withTestQueue`), which lives in
 * a per-worker schema. Without it the integration suite would enqueue into
 * the developer's own `rm_dev` pg-boss schema.
 */
export function setQueue(instance: NotificationQueue | undefined): void {
  globalForQueue.rmQueue = instance ? Promise.resolve(instance) : undefined;
}
