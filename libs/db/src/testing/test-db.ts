import { createPrismaClient, type Db } from '../lib/client';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://rm:rm@localhost:5432/rm_test';

let client: Db | undefined;

/** Returns a singleton Prisma client pointed at the throwaway test database. */
export function withTestDb(): Db {
  client ??= createPrismaClient(TEST_DATABASE_URL);
  return client;
}

/**
 * Truncates every application table, leaving migrations intact.
 * Call this in `beforeEach` so each test starts from a known empty state.
 */
export async function resetDatabase(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
