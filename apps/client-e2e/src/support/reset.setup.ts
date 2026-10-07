import { execFileSync } from 'node:child_process';
import { test as setup } from '@playwright/test';
import { closeDb, db } from './fixtures';
import { e2eProcessEnv, WORKSPACE_ROOT } from './e2e-env';

/**
 * Runs once, before every spec (a Playwright "setup" project the specs
 * depend on): the E2E database starts from nothing on every run.
 *
 * Migrations are applied, every table is emptied, and the regular seed puts
 * back the permission catalogue and the initial administrator. Each spec
 * then creates exactly the trips and customers it needs, so no spec depends
 * on another's leftovers or on the order they run in.
 */
setup('reset the E2E database', async () => {
  const env = e2eProcessEnv();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: WORKSPACE_ROOT, env, stdio: 'pipe' });

  const tables = await db().$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length > 0) {
    const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
    await db().$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await closeDb();

  execFileSync('pnpm', ['exec', 'tsx', 'libs/db/prisma/seed.ts'], { cwd: WORKSPACE_ROOT, env, stdio: 'pipe' });
});
