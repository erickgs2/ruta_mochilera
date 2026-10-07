import 'dotenv/config';
import { isAbsolute, resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { createPrismaClient } from '@rm/db';
import { loadEnv } from '@rm/shared-utils';
import { createEmail } from '@rm/email';
import { applyImport } from '@rm/domain-imports';
import { deliverQueuedEmail } from '@rm/domain-notifications';
import { createCancelPendingPaymentIntents } from '@rm/domain-payments';
import { organizationTimeZone } from '@rm/domain-settings';
import { createPaymentProvider } from '@rm/payments-stripe';
import { PdfLibReceiptRenderer } from '@rm/receipts';
import { createStorage } from '@rm/storage';
import {
  APPLY_IMPORT_JOB,
  EXPIRE_HOLDS_JOB,
  JOB_NAMES,
  RECONCILE_PAID_CENTS_JOB,
  SEND_NOTIFICATION_EMAIL_JOB,
  SEND_RECEIPT_JOB,
  WARN_EXPIRING_HOLDS_JOB,
  type ApplyImportPayload,
  type SendNotificationEmailPayload,
  type SendReceiptPayload,
} from '@rm/jobs';
import { runExpireHolds } from './jobs/run-expire-holds';
import { warnExpiringHolds } from './jobs/warn-expiring-holds';
import { reconcilePaidCents } from './jobs/reconcile-paid-cents';
import { sendReceipt } from './jobs/send-receipt';

/**
 * The background worker (Task 8). A separate Node process from `apps/api`
 * on purpose: jobs living inside Next.js get killed mid-flight by every
 * redeploy, and `expireHolds` mid-pass is exactly the kind of work a
 * container restart must never interrupt.
 *
 * Owns only scheduling and wiring: every job's actual logic
 * (`src/jobs/*.ts`) is a plain function of the database client, tested on
 * its own without starting pg-boss at all. This file's only job is to call
 * those functions on a schedule and to shut down cleanly.
 */

const env = loadEnv(process.env);
const db = createPrismaClient(env.databaseUrl);
const email = createEmail(env);
const paymentProvider = createPaymentProvider(env);
const cancelPendingPaymentIntents = createCancelPendingPaymentIntents(paymentProvider);
// Receipts are written here and read back by the API, so both must see the
// same files. A relative STORAGE_LOCAL_ROOT (development) is relative to the
// API's directory, which is where `nx dev api` runs; this process runs from
// apps/worker. In production the driver is S3 and this changes nothing.
const storage = createStorage(
  env.storageLocalRoot && !isAbsolute(env.storageLocalRoot)
    ? { ...env, storageLocalRoot: resolve(__dirname, '../../api', env.storageLocalRoot) }
    : env
);
const receiptRenderer = new PdfLibReceiptRenderer();
// No explicit `schema` here: pg-boss's own default (`pgboss`) sits next to
// Prisma's default (`public`), the same deliberate separation the test
// harness gives each of them in `@rm/jobs/testing` -- see that module's doc
// comment for why the two must never share one schema.
const boss = new PgBoss({ connectionString: env.databaseUrl });

let stopping: Promise<void> | undefined;

async function shutdown(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    // Stops taking new work and waits for whatever is already in hand --
    // the exact guarantee a container restart needs mid-`expireHolds`.
    await boss.stop({ graceful: true, close: true });
    await db.$disconnect();
  })();
  return stopping;
}

async function main(): Promise<void> {
  boss.on('error', (error) => {
    console.error('[worker] pg-boss error', error);
  });

  await boss.start();
  for (const name of JOB_NAMES) {
    await boss.createQueue(name);
  }

  const timeZone = await organizationTimeZone(db);

  await boss.schedule(EXPIRE_HOLDS_JOB, '*/5 * * * *');
  await boss.schedule(WARN_EXPIRING_HOLDS_JOB, '0 * * * *');
  // Nightly, in the organisation's own timezone -- never a hardcoded one.
  await boss.schedule(RECONCILE_PAID_CENTS_JOB, '0 3 * * *', null, { tz: timeZone });

  await boss.work(EXPIRE_HOLDS_JOB, async () => {
    await runExpireHolds(db, boss, cancelPendingPaymentIntents);
  });
  await boss.work(WARN_EXPIRING_HOLDS_JOB, async () => {
    await warnExpiringHolds(db, boss);
  });
  await boss.work(RECONCILE_PAID_CENTS_JOB, async () => {
    await reconcilePaidCents(db, boss);
  });
  await boss.work<SendNotificationEmailPayload>(SEND_NOTIFICATION_EMAIL_JOB, async (jobs) => {
    for (const job of jobs) {
      await deliverQueuedEmail(db, email, job.data.deliveryId);
    }
  });
  await boss.work<SendReceiptPayload>(SEND_RECEIPT_JOB, async (jobs) => {
    for (const job of jobs) {
      const result = await sendReceipt(db, storage, receiptRenderer, email, job.data);
      // Thrown so pg-boss retries: the PDF is already stored, only the email
      // is missing (see `sendReceipt`).
      if (!result.ok) throw new Error(`Receipt for payment ${job.data.paymentId} not sent: ${result.error.code}`);
    }
  });
  await boss.work<ApplyImportPayload>(APPLY_IMPORT_JOB, async (jobs) => {
    for (const job of jobs) {
      // A failed row is in the report, not an error; only a batch that is
      // missing or not APPLYING comes back failed, and retrying would not help.
      const result = await applyImport(db, { queue: boss, mail: { email, clientAppUrl: env.clientAppUrl } }, job.data);
      if (!result.ok) console.warn(`[worker] import ${job.data.batchId} not applied: ${result.error.code}`);
    }
  });

  process.on('SIGTERM', () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('[worker] error during shutdown', error);
        process.exit(1);
      });
  });

  console.log('[worker] started');
}

main().catch((error: unknown) => {
  console.error('[worker] fatal startup error', error);
  process.exit(1);
});
