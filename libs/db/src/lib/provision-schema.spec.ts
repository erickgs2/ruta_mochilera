import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, provisionSchema, withTestDb } from '../testing';

const db = withTestDb();

// Not worker schemas: no `_w<id>` tail, so the cleanup script never lists them.
const SCHEMAS = ['test_zz_provision_a', 'test_zz_provision_b', 'test_zz_provision_c', 'test_zz_provision_d', 'test_zz_provision_e', 'test_zz_provision_f'];

// Vitest runs with the project directory (libs/db) as cwd.
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');
const migrationCount = readdirSync(MIGRATIONS_DIR).filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory()).length;

async function appliedCount(schema: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM "${schema}"."_prisma_migrations" WHERE finished_at IS NOT NULL`
  );
  return Number(rows[0]?.n);
}

describe('provisionSchema', () => {
  afterAll(async () => {
    for (const schema of SCHEMAS) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await closeTestDb();
  });

  it('migrates several different schemas at once without waiting for one another', async () => {
    const batch = SCHEMAS.slice(0, 5);
    await Promise.all(batch.map((schema) => db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)));

    await Promise.all(batch.map((schema) => provisionSchema(schema, db)));

    for (const schema of batch) expect(await appliedCount(schema)).toBe(migrationCount);
  }, 120_000);

  it('does not depend on Prisma Migrate\'s database-wide advisory lock', async () => {
    const schema = SCHEMAS[5]!;
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

    // Another session holds the lock `migrate deploy` would take (72707369).
    // Before, this waited the full 10s and failed with P1002.
    await db.$transaction(
      async (holder) => {
        await holder.$executeRaw`SELECT pg_advisory_xact_lock(72707369)`;
        await provisionSchema(schema, db);
      },
      { timeout: 120_000 }
    );

    expect(await appliedCount(schema)).toBe(migrationCount);
  }, 120_000);

  it('lets two preparations of the same schema queue and both finish', async () => {
    const schema = SCHEMAS[0]!;
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

    await Promise.all([provisionSchema(schema, db), provisionSchema(schema, db), provisionSchema(schema, db)]);

    expect(await appliedCount(schema)).toBe(migrationCount);
  }, 120_000);
});
