import { PgBoss } from 'pg-boss';
import { TEST_SCHEMA } from '@rm/db/testing';
import { JOB_NAMES } from '../lib/job-names';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

/**
 * pg-boss's own schema for this Vitest worker, kept apart from `TEST_SCHEMA`
 * (where Prisma's own tables live) on purpose.
 *
 * `@rm/db/testing#resetDatabase` truncates every table in `TEST_SCHEMA`
 * between tests so each test starts from a known-empty state; if pg-boss's
 * `queue`/`version` bookkeeping lived there too, that truncation would wipe
 * queue registration along with business rows and every test would have to
 * re-run `createQueue`. A sibling schema -- still unique per worker and per
 * project, since it is derived from `TEST_SCHEMA` -- keeps the two
 * truncation stories apart, and keeps pg-boss's own queue state from leaking
 * between parallel workers or parallel Nx projects the way an un-isolated
 * schema would (the same class of cross-talk `TEST_SCHEMA` itself exists to
 * avoid; see its doc comment in `@rm/db/testing`).
 */
export const TEST_JOB_SCHEMA = `${TEST_SCHEMA.length <= 55 ? TEST_SCHEMA : TEST_SCHEMA.slice(0, 55)}_jobs`;

let boss: PgBoss | undefined;
let started: Promise<PgBoss> | undefined;

/**
 * Returns a singleton `PgBoss` instance, started and with every known queue
 * (`@rm/jobs`'s `JOB_NAMES`) created, bound to this worker's isolated
 * `TEST_JOB_SCHEMA`. Call it in `beforeAll`; safe to call repeatedly.
 */
export function withTestQueue(): Promise<PgBoss> {
  started ??= startTestQueue();
  return started;
}

async function startTestQueue(): Promise<PgBoss> {
  const instance = new PgBoss({ connectionString: TEST_DATABASE_URL, schema: TEST_JOB_SCHEMA });
  // Background maintenance (expired job cleanup, etc.) can emit `error` after
  // a test's own assertions are done; unhandled, that crashes the whole
  // Vitest worker process. There is nothing a test can do about it, so it is
  // swallowed here rather than left to find no listener.
  instance.on('error', () => undefined);
  await instance.start();
  for (const name of JOB_NAMES) {
    await instance.createQueue(name);
  }
  boss = instance;
  return instance;
}

/**
 * Clears every job (queued, active, completed) from every known queue,
 * leaving `createQueue`'s registration and pg-boss's own schema version
 * untouched. Call in `beforeEach` so each test starts from an empty queue
 * without re-paying `startTestQueue`'s setup cost.
 */
export async function resetTestQueue(): Promise<void> {
  if (!boss) return;
  for (const name of JOB_NAMES) {
    await boss.deleteAllJobs(name);
  }
}

/** Stops the singleton and releases its connection pool. Call in `afterAll`. */
export async function closeTestQueue(): Promise<void> {
  const current = boss;
  boss = undefined;
  started = undefined;
  if (current) await current.stop({ graceful: false, timeout: 1000 });
}
