import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, TEST_POOL_MAX, withQueryCountingDb, withTestDb } from '../testing';

const db = withTestDb();

describe('test database pool', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // Every Vitest worker holds its own pool and PostgreSQL allows 100
  // connections in all: an uncapped pool of 10 per worker runs the server out
  // of them when several projects test at once (P1001/P1002).
  it('never opens more connections than the cap, however many queries run at once', async () => {
    const marker = `pool_cap_${Date.now()}`;
    // Prisma queries are lazy: `Promise.all` is what actually starts them.
    const busy = Promise.all(
      Array.from({ length: TEST_POOL_MAX * 3 }, () => db.$queryRawUnsafe(`SELECT pg_sleep(0.3)::text AS slept, '${marker}' AS marker`))
    );

    const peak = await withQueryCountingDb(async (observer) => {
      let highest = 0;
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const rows = await observer.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%${marker}%' AND query NOT LIKE '%pg_stat_activity%'`
        );
        highest = Math.max(highest, Number(rows[0]?.n ?? 0));
      }
      return highest;
    });
    await busy;

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(TEST_POOL_MAX);
  });
});
