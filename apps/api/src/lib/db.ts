import { createPrismaClient, type Db } from '@rm/db';
import { config } from './config';

// In development, Next.js hot-reloads modules; the client is cached on
// `globalThis` so a reload does not exhaust the connection pool.
const globalForDb = globalThis as unknown as { rmDb?: Db };

export function db(): Db {
  globalForDb.rmDb ??= createPrismaClient(config().databaseUrl);
  return globalForDb.rmDb;
}

/**
 * Test-only seam: overrides the singleton every route handler resolves
 * through `db()`.
 *
 * Without this, `db()` would build its client from `config().databaseUrl`,
 * which is `DATABASE_URL` — the developer's own `rm_dev` database — and the
 * integration suite would write to it directly, bypassing the per-worker
 * schema isolation `@rm/db/testing` provides for every other suite in this
 * workspace.
 *
 * The alternative considered was a `NODE_ENV === 'test'` branch inside `db()`
 * itself; that was rejected because it puts a test-only conditional on the
 * request path that every production call to `db()` would also evaluate.
 * This setter keeps that branch out of `db()` entirely: production code never
 * calls `setDb`, and only `src/test-setup.ts` (wired as a Vitest `setupFiles`
 * entry, so it runs before any route handler module is imported) calls it,
 * pointing the singleton at the isolated test client from
 * `@rm/db/testing#withTestDb()` for the lifetime of the test process.
 */
export function setDb(client: Db | undefined): void {
  globalForDb.rmDb = client;
}
