import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { createPrismaClient } from '../src/lib/client';
import {
  classifyTestSchema,
  findWorkspaceRoot,
  isDroppableTestSchema,
  schemaScope,
  type TestSchemaOwner,
} from '../src/testing/schema-name';

/**
 * Drops the per-worker schemas that test runs leave behind in the test
 * database. Which ones is decided by who owns them (see `classifyTestSchema`):
 *
 *   (no flags)    dry run: list every test schema, grouped by owner, drop nothing
 *   --apply       drop this checkout's schemas
 *   --legacy      with --apply, also the old shared test_<project>_w<id> ones
 *   --others      with --apply, also every other checkout's (asks first)
 *   --yes         skip the question --others asks
 *
 * Another checkout's schemas can be in use right now, so they are never
 * touched by default. A drop that cannot get its lock in 3s is reported and
 * skipped: that schema is being used.
 */
const DEFAULT_TEST_DATABASE_URL = 'postgresql://rm:rm@localhost:5432/rm_test';
const LOCK_TIMEOUT = '3s';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !['--apply', '--legacy', '--others', '--yes'].includes(arg));
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(' ')}`);
  process.exit(2);
}
const apply = args.has('--apply');
if (!apply && (args.has('--legacy') || args.has('--others') || args.has('--yes'))) {
  console.error('--legacy, --others and --yes only apply together with --apply.');
  process.exit(2);
}

async function main(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
  const scope = schemaScope(findWorkspaceRoot(process.cwd()));
  const db = createPrismaClient(url, { poolMax: 1 });
  try {
    const rows = await db.$queryRaw<{ name: string }[]>`
      SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'test\\_%' ORDER BY nspname
    `;
    const groups: Record<TestSchemaOwner, string[]> = { own: [], 'other-scope': [], legacy: [], unrelated: [] };
    for (const { name } of rows) groups[classifyTestSchema(name, scope)].push(name);

    console.log(`Test database: ${new URL(url).pathname.slice(1)}   this checkout's scope: ${scope}`);
    console.log(`  own          ${groups.own.length}  (this checkout)`);
    console.log(`  legacy       ${groups.legacy.length}  (old shared names, no scope)`);
    console.log(`  other scope  ${groups['other-scope'].length}  (other checkouts; may be in use)`);
    console.log(`  unrelated    ${groups.unrelated.length}  (never touched)`);

    if (!apply) {
      console.log('\nDry run: nothing dropped. Add --apply to drop this checkout\'s schemas (--legacy, --others for more).');
      return;
    }

    const doomed = [...groups.own, ...(args.has('--legacy') ? groups.legacy : []), ...(args.has('--others') ? groups['other-scope'] : [])];
    if (args.has('--others') && groups['other-scope'].length > 0 && !args.has('--yes')) {
      if (!process.stdin.isTTY) {
        console.error('\n--others needs a yes: pass --yes, or run it from a terminal.');
        process.exit(1);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`\nDrop ${groups['other-scope'].length} schema(s) of OTHER checkouts too? Type "yes": `);
      rl.close();
      if (answer.trim() !== 'yes') {
        console.log('Aborted, nothing dropped.');
        return;
      }
    }

    let dropped = 0;
    const skipped: string[] = [];
    for (const name of doomed) {
      // `name` is interpolated into the DROP, so it is checked here, name by
      // name, whatever the listing query matched.
      if (!isDroppableTestSchema(name)) {
        console.warn(`Skipping ${JSON.stringify(name)}: not a plain test_[a-z0-9_]+ identifier of at most 63 bytes.`);
        skipped.push(name);
        continue;
      }
      try {
        await db.$transaction([
          db.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`),
          db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`),
        ]);
        dropped += 1;
      } catch {
        skipped.push(name);
      }
    }
    console.log(`\nDropped ${dropped} schema(s).`);
    if (skipped.length > 0) console.log(`Skipped ${skipped.length} that could not be locked (in use?): ${skipped.join(', ')}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
