import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient, searchPathStartupOption, type Db, type DbTransactionClient } from '../lib/client';
import { composeSchemaName, findWorkspaceRoot } from './schema-name';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

const execFileAsync = promisify(execFile);

/** How long one schema's migration may hold its lock (and so how long a second process waits for it). */
const MIGRATE_TIMEOUT_MS = 180_000;

/**
 * Upper bound of every test client's connection pool (`TEST_DB_POOL_MAX`, 4
 * by default). Each Vitest worker of each project holds its own pool and the
 * test PostgreSQL allows 100 connections in all, so the driver's default of
 * 10 per worker runs the server out when several projects test at once
 * (P1001/P1002 under load). Four still lets concurrent domain calls overlap;
 * a spec that needs more raises the variable for its own run.
 */
export const TEST_POOL_MAX = Math.max(1, Number(process.env['TEST_DB_POOL_MAX'] ?? 4) || 4);

// Declared before `TEST_SCHEMA` on purpose: that constant is initialised at
// module load and reaches this cache through `projectKey()`.
let cachedRoot: string | undefined;

/**
 * Every Vitest worker of every project gets its own PostgreSQL schema inside
 * the single test database.
 *
 * Vitest runs spec files in parallel workers, and `nx run-many` runs projects
 * in parallel on top of that, so a `beforeEach` that truncates shared tables
 * would let one suite delete another suite's rows mid-test. Qualifying every
 * query with a private schema removes the shared state entirely instead of
 * serialising access to it, so suites stay parallel and a new suite costs
 * nothing.
 *
 * The key needs both halves. `VITEST_WORKER_ID` (0-based in Vitest 4, despite
 * the name) is unique only *within one* Vitest process, and each Nx project is
 * its own Vitest process numbering its workers from scratch — so two projects
 * tested in the same `nx run-many` batch would otherwise both land on worker 0.
 * Prefixing with the project makes the name unique across processes too.
 *
 * Neither half tells two *checkouts* apart: the main working tree and every git
 * worktree share the one `rm_test`, and each would otherwise name its API
 * project's first worker `test_api_w0` -- the same schema, truncated by
 * whichever suite starts a test first. So the name also carries a short
 * fingerprint of the workspace root (`test_<fingerprint>_<project>_w<id>`),
 * stable for a checkout and different between checkouts. `TEST_SCHEMA_PREFIX`
 * replaces the fingerprint for a caller that wants a name it can predict.
 *
 * The key is deliberately stable rather than random: a worker reuses the schema
 * it already migrated on a previous run, which is what keeps `prepareTestDb()`
 * down to two queries after the first run.
 */
export const TEST_SCHEMA = composeSchemaName({
  project: projectKey(),
  workerId: process.env['VITEST_WORKER_ID'] ?? '0',
  workspaceRoot: workspaceRoot(),
});

let client: Db | undefined;
let prepared: Promise<void> | undefined;

/** Returns a singleton Prisma client pointed at this worker's schema in the test database. */
export function withTestDb(): Db {
  client ??= createPrismaClient(TEST_DATABASE_URL, { schema: TEST_SCHEMA, poolMax: TEST_POOL_MAX });
  return client;
}

/**
 * Creates this worker's schema and applies every migration to it, once per
 * worker process. Call it in `beforeAll`; it is idempotent and cheap (two
 * queries) once the schema is up to date.
 */
export function prepareTestDb(): Promise<void> {
  prepared ??= provisionWorkerSchema();
  return prepared;
}

/**
 * Disconnects the singleton client and releases its connection pool.
 *
 * The `pg` driver adapter keeps a live pool per client, so a suite that never
 * disconnects leaves sockets open until the process exits. With several suites
 * running at once that adds up against PostgreSQL's `max_connections`, so every
 * integration suite must call this in `afterAll`.
 */
export async function closeTestDb(): Promise<void> {
  const current = client;
  client = undefined;
  prepared = undefined;
  if (current) await current.$disconnect();
}

/**
 * Truncates every application table in this worker's schema, leaving the
 * migration bookkeeping intact.
 * Call this in `beforeEach` so each test starts from a known empty state.
 */
export async function resetDatabase(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${TEST_SCHEMA} AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${TEST_SCHEMA}"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Runs `run` against a throwaway client on this worker's schema that counts
 * every SQL statement it sends to PostgreSQL, and returns what `run` returns.
 *
 * Exists so a suite can assert that an operation's query count does not grow
 * with the size of its input -- an N+1 regression. Counting at the client is
 * the only place the difference is observable: a service that loops and a
 * service that batches are identical from the outside, and `vi.mock(module,
 * { spy: true })` does not intercept a module calling its own function in
 * ESM, so spying on the inner helper proves nothing.
 *
 * It is a second client rather than the shared one because query events need
 * `log` wired up at construction. It sees the same committed rows, so a test
 * seeds through `withTestDb()` as usual and only runs the measured call in
 * here. The client is disconnected on the way out, including on failure:
 * `pg` keeps a pool per client and the suites run in parallel against one
 * PostgreSQL.
 */
export async function withQueryCountingDb<T>(
  run: (db: Db, queryCount: () => number) => Promise<T>
): Promise<T> {
  const adapter = new PrismaPg(
    { connectionString: TEST_DATABASE_URL, options: searchPathStartupOption(TEST_SCHEMA), max: TEST_POOL_MAX },
    { schema: TEST_SCHEMA }
  );
  const client = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
  let queries = 0;
  client.$on('query', () => {
    queries += 1;
  });
  try {
    return await run(client, () => queries);
  } finally {
    await client.$disconnect();
  }
}

/**
 * Re-exported for existing callers that imported it from here: the
 * implementation now lives in `../lib/prisma-errors` so production domain
 * code can use it too without pulling in this module's module-load-time
 * schema-name computation (see that file's doc comment for why).
 */
export { uniqueViolationIndex } from '../lib/prisma-errors';

async function provisionWorkerSchema(): Promise<void> {
  await provisionSchema(TEST_SCHEMA, withTestDb());
}

/**
 * Brings `schema` of the test database up to date with every migration (the
 * schema is created on the way if it does not exist).
 *
 * Prisma Migrate takes `pg_advisory_lock(72707369)` around `migrate deploy`,
 * and that lock belongs to the whole *database*, not to the schema being
 * migrated. Every worker of every project of every checkout migrates its own
 * schema in the one `rm_test`, so the lock serialised work that never
 * conflicted -- and once enough of them queued, the 10s Prisma waits for it
 * ran out (P1002 "Timed out trying to acquire a postgres advisory lock"; the
 * `identity`, `customers` and `payments` suites failed that way under a normal
 * parallel `nx run-many`).
 *
 * So the global lock is switched off (`PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`,
 * a variable the schema engine of this Prisma version checks for, and the
 * documented switch for exactly this) and replaced by one that is as narrow as
 * the thing it protects: a transaction-level advisory lock keyed by the
 * schema's name. Two processes preparing *different* schemas never wait for
 * each other; two preparing the *same* one (the same project run twice in one
 * checkout) still queue, and the second finds the work done.
 */
export async function provisionSchema(schema: string, db: Db): Promise<void> {
  const expected = migrationNames();
  if (await isUpToDate(db, schema, expected)) return;

  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  // The transaction exists only to hold the lock while the CLI runs in a child
  // process; it ends, and releases the lock, when the migration does. The
  // child uses its own connection, so this one is not in its way.
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${schema}, 0))`;
      // No CREATE SCHEMA here: `migrate deploy` creates a missing schema itself,
      // and one made inside this still-open transaction would be invisible to its
      // connection yet block its own CREATE SCHEMA -- a deadlock.
      // Someone else may have finished while this process waited for the lock.
      if (await isUpToDate(tx, schema, expected)) return;
      await migrateDeploy(schema, url);
    },
    { timeout: MIGRATE_TIMEOUT_MS, maxWait: MIGRATE_TIMEOUT_MS }
  );
}

async function migrateDeploy(schema: string, url: URL): Promise<void> {
  try {
    const migration = execFileAsync(join(workspaceRoot(), 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: workspaceRoot(),
      env: { ...process.env, DATABASE_URL: url.toString(), PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1' },
      encoding: 'utf8',
    });
    // Nothing to tell it: close its stdin so it never waits for input.
    migration.child.stdin?.end();
    await migration;
  } catch (error) {
    // Captured rather than ignored: a broken migration must explain itself
    // here instead of surfacing as a bare non-zero exit.
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    const output = [stdout, stderr]
      .map((stream) => stream?.trim())
      .filter((stream) => stream)
      .join('\n');
    throw new Error(
      `prisma migrate deploy failed for schema "${schema}".` + (output ? `\n${output}` : ' The CLI produced no output.'),
      { cause: error }
    );
  }
}

async function isUpToDate(db: Db | DbTransactionClient, schema: string, expected: string[]): Promise<boolean> {
  const applied = await appliedMigrationNames(db, schema);
  return expected.every((name) => applied.has(name));
}

/**
 * Identifies the Vitest process. Under `nx run`/`nx run-many` that is the Nx
 * project name; when Vitest is invoked directly it falls back to the project
 * directory's path relative to the workspace root, which is equally stable and
 * equally unique. Running every project from a single root Vitest process
 * collapses them all onto one key, which is safe: in that case there is only
 * one process, so `VITEST_WORKER_ID` is unique on its own.
 */
function projectKey(): string {
  const fromNx = process.env['NX_TASK_TARGET_PROJECT'];
  if (fromNx) return fromNx;
  const relative = resolve(process.cwd()).slice(workspaceRoot().length);
  return relative === '' ? 'root' : relative;
}

function migrationNames(): string[] {
  const dir = join(workspaceRoot(), 'libs', 'db', 'prisma', 'migrations');
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort();
}

async function appliedMigrationNames(db: Db | DbTransactionClient, schema: string): Promise<Set<string>> {
  const present = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = '_prisma_migrations'
    ) AS exists
  `;
  if (!present[0]?.exists) return new Set();
  const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM "${schema}"."_prisma_migrations" WHERE finished_at IS NOT NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

/** The workspace root, found once from the current working directory. */
function workspaceRoot(): string {
  cachedRoot ??= findWorkspaceRoot(process.cwd());
  return cachedRoot;
}
