import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient, searchPathStartupOption, type Db } from '../lib/client';
import { composeSchemaName, findWorkspaceRoot } from './schema-name';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

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
  const db = withTestDb();
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);

  const expected = migrationNames();
  const applied = await appliedMigrationNames(db);
  if (expected.every((name) => applied.has(name))) return;

  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('schema', TEST_SCHEMA);
  // `migrate deploy` takes a database-wide advisory lock, so concurrent workers
  // queue rather than collide. It only runs when a migration is missing.
  try {
    execFileSync(join(workspaceRoot(), 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: workspaceRoot(),
      env: { ...process.env, DATABASE_URL: url.toString() },
      // Captured rather than ignored: a broken migration must explain itself
      // here instead of surfacing as a bare non-zero exit.
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    const output = [stdout, stderr]
      .map((stream) => stream?.trim())
      .filter((stream) => stream)
      .join('\n');
    throw new Error(
      `prisma migrate deploy failed for schema "${TEST_SCHEMA}".` +
        (output ? `\n${output}` : ' The CLI produced no output.'),
      { cause: error }
    );
  }
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

async function appliedMigrationNames(db: Db): Promise<Set<string>> {
  const present = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = '_prisma_migrations'
    ) AS exists
  `;
  if (!present[0]?.exists) return new Set();
  const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM "${TEST_SCHEMA}"."_prisma_migrations" WHERE finished_at IS NOT NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

/** The workspace root, found once from the current working directory. */
function workspaceRoot(): string {
  cachedRoot ??= findWorkspaceRoot(process.cwd());
  return cachedRoot;
}
