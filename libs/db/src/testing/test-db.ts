import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  assertSchemaIdentifier,
  createPrismaClient,
  searchPathStartupOption,
  type Db,
} from '../lib/client';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

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
 * The key is deliberately stable rather than random: a worker reuses the schema
 * it already migrated on a previous run, which is what keeps `prepareTestDb()`
 * down to two queries after the first run.
 */
export const TEST_SCHEMA = composeSchemaName(projectKey(), process.env['VITEST_WORKER_ID'] ?? '0');

let client: Db | undefined;
let prepared: Promise<void> | undefined;

/** Returns a singleton Prisma client pointed at this worker's schema in the test database. */
export function withTestDb(): Db {
  client ??= createPrismaClient(TEST_DATABASE_URL, { schema: TEST_SCHEMA });
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
    { connectionString: TEST_DATABASE_URL, options: searchPathStartupOption(TEST_SCHEMA) },
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

/**
 * Builds a schema name that is a safe SQL identifier: lowercased, every
 * character outside `[a-z0-9_]` folded to `_`, and truncated with a hash
 * suffix so it can never exceed PostgreSQL's 63-byte identifier limit. The
 * validation applies to the fully composed name because a project name may
 * legally contain characters an identifier may not, and it is the same
 * `assertSchemaIdentifier` the connection builder applies, so a name this
 * function accepts can never be one `search_path` rejects.
 */
function composeSchemaName(project: string, workerId: string): string {
  const slug = `test_${project}_w${workerId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_');
  const name = slug.length <= 63 ? slug : `${slug.slice(0, 54)}_${fingerprint(slug)}`;
  assertSchemaIdentifier(name);
  return name;
}

/** Short deterministic digest (djb2), used only to keep long schema names unique. */
function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  return hash.toString(36).padStart(7, '0');
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

/**
 * Walks up from the current working directory until it finds the directory
 * holding `prisma.config.ts`. Vitest runs with the project directory as cwd, so
 * this resolves the workspace root from any library's suite.
 */
function workspaceRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'prisma.config.ts'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('Could not locate the workspace root (no prisma.config.ts found)');
    dir = parent;
  }
}
