// Vitest `setupFiles` entry: runs once per worker before any test module
// (and therefore before any route handler, and before `db.ts`'s own
// singleton is ever created) is imported.
//
// This installs the per-worker isolated Prisma client from `@rm/db/testing`
// as the singleton every route handler resolves through `db()`, in place of
// the client `db()` would otherwise lazily build from `DATABASE_URL` (the
// developer's `rm_dev` database). See `src/lib/db.ts` for the full rationale.
import { withTestDb } from '@rm/db/testing';
import { setDb } from './lib/db';

setDb(withTestDb());
