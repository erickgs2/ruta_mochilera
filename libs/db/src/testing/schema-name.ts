import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSchemaIdentifier } from '../lib/client';

/**
 * How a test worker's PostgreSQL schema is named. Kept apart from `test-db.ts`
 * because that module computes `TEST_SCHEMA` the moment it is imported; the
 * naming rules here are pure, so a spec (and the cleanup script) can call them
 * with any workspace root.
 */

/** PostgreSQL truncates identifiers longer than this many bytes. */
const MAX_IDENTIFIER_BYTES = 63;

/** Length of the workspace fingerprint in a schema name. */
const FINGERPRINT_LENGTH = 6;

/**
 * Short, stable digest of a workspace root: the same checkout always gets the
 * same value, two checkouts (the main one and each git worktree) get
 * different ones. It is what keeps `test_api_w0` of one worktree from being
 * the very same schema as `test_api_w0` of another while both run at once on
 * the single test database.
 */
export function workspaceFingerprint(root: string): string {
  return createHash('sha1').update(resolve(root)).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * The part of the name that scopes it to one checkout: `TEST_SCHEMA_PREFIX`
 * when set (for a caller that wants a name it can predict), else the
 * workspace fingerprint.
 */
export function schemaScope(root: string, override = process.env['TEST_SCHEMA_PREFIX']): string {
  return override ? slugify(override) : workspaceFingerprint(root);
}

/**
 * Builds a schema name that is a safe SQL identifier:
 * `test_<scope>_<project>_w<workerId>`, lowercased, every character outside
 * `[a-z0-9_]` folded to `_`, and truncated with a hash suffix so it can never
 * exceed PostgreSQL's 63-byte identifier limit. The scope sits at the front,
 * so truncation can never cut it off. The validation applies to the fully
 * composed name because a project name may legally contain characters an
 * identifier may not, and it is the same `assertSchemaIdentifier` the
 * connection builder applies, so a name this function accepts can never be
 * one `search_path` rejects.
 */
export function composeSchemaName(input: { project: string; workerId: string; workspaceRoot: string; scope?: string }): string {
  const scope = input.scope === undefined ? schemaScope(input.workspaceRoot) : slugify(input.scope);
  const slug = slugify(`test_${scope}_${input.project}_w${input.workerId}`);
  const name =
    Buffer.byteLength(slug) <= MAX_IDENTIFIER_BYTES ? slug : `${slug.slice(0, 54)}_${fingerprint(slug)}`;
  assertSchemaIdentifier(name);
  return name;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_');
}

/** Short deterministic digest (djb2), used only to keep long schema names unique. */
function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  return hash.toString(36).padStart(7, '0');
}

/**
 * Walks up from `startDir` until it finds the directory holding
 * `prisma.config.ts`. Vitest runs with the project directory as cwd, so this
 * resolves the workspace root from any library's suite.
 */
export function findWorkspaceRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'prisma.config.ts'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('Could not locate the workspace root (no prisma.config.ts found)');
    dir = parent;
  }
}

/** Who a schema of the test database belongs to, as far as its name says. */
export type TestSchemaOwner = 'own' | 'other-scope' | 'legacy' | 'unrelated';

/**
 * Classifies a schema name against this checkout's `scope` (see
 * `schemaScope`): `own` carries this scope; `other-scope` carries another
 * 6-hex fingerprint (some other checkout's, or a custom `TEST_SCHEMA_PREFIX`
 * that happens to look like one); `legacy` is the old `test_<project>_w<id>`
 * shape, which every checkout without the fingerprint still shares; anything
 * else is not a test worker's schema at all.
 */
export function classifyTestSchema(name: string, scope: string): TestSchemaOwner {
  if (name.startsWith(`test_${scope}_`)) return 'own';
  if (/^test_[0-9a-f]{6}_.+_w\d+(_jobs)?$/.test(name)) return 'other-scope';
  if (/^test_.+_w\d+(_jobs)?$/.test(name)) return 'legacy';
  return 'unrelated';
}

/**
 * Whether `name` is something the cleanup script may put inside a
 * `DROP SCHEMA "<name>"`: a test schema (`test_` prefix), a plain
 * `[a-z0-9_]+` identifier, within PostgreSQL's 63-byte limit. The names come
 * out of `pg_namespace`, where anything -- a quote included -- can sit, so
 * this is checked on every name right before its drop, not trusted from the
 * `LIKE` that listed it.
 */
export function isDroppableTestSchema(name: string): boolean {
  return name.startsWith('test_') && /^[a-z0-9_]+$/.test(name) && Buffer.byteLength(name) <= MAX_IDENTIFIER_BYTES;
}
