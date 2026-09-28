import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrismaClient, type Db } from '../lib/client';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

/**
 * Every Vitest worker gets its own PostgreSQL schema inside the single test
 * database.
 *
 * Vitest runs spec files in parallel workers and `nx run-many` runs projects in
 * parallel too, so a `beforeEach` that truncates shared tables would let one
 * suite delete another suite's rows mid-test. Qualifying every query with a
 * per-worker schema removes the shared state entirely instead of serialising
 * access to it, so suites stay parallel and a new suite costs nothing.
 *
 * `VITEST_WORKER_ID` is 1-based and stable for the life of a worker process.
 */
export const TEST_SCHEMA = `test_w${process.env['VITEST_WORKER_ID'] ?? '1'}`;

if (!/^[a-z0-9_]+$/.test(TEST_SCHEMA)) {
  throw new Error(`Refusing to use "${TEST_SCHEMA}" as a schema name: expected [a-z0-9_]+`);
}

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
 * Returns the name of the violated unique index when `error` is Prisma's
 * unique-constraint failure (P2002), and `undefined` for anything else.
 *
 * Asserting on this rather than on `rejects.toThrow()` is what makes a
 * constraint test fail for the right reason: a connection error, a validation
 * error or a violation of a *different* unique index all return `undefined`.
 *
 * Note for Prisma 7: with a driver adapter the classic `meta.target` is no
 * longer populated. The violated index arrives inside the adapter error, which
 * is why this helper exists instead of an inline property read.
 */
export function uniqueViolationIndex(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code !== 'P2002' || typeof meta !== 'object' || meta === null) return undefined;
  const cause = (meta as { driverAdapterError?: { cause?: unknown } }).driverAdapterError?.cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const index = (cause as { constraint?: { index?: unknown } }).constraint?.index;
  return typeof index === 'string' ? index : undefined;
}

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
  execFileSync(join(workspaceRoot(), 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: workspaceRoot(),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'ignore',
  });
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

let cachedRoot: string | undefined;

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
