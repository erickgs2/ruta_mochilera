import type { Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import { PERMISSIONS, type PermissionKey } from './permissions';

export interface Actor {
  userId: string;
  type: 'STAFF' | 'CUSTOMER';
  locale: 'es' | 'en';
  permissions: readonly PermissionKey[];
}

/**
 * Built once at module scope so filtering a loaded key against the catalog is
 * an O(1) `Set` lookup rather than an `Array.includes` scan per key.
 */
const CATALOG_KEYS = new Set<string>(PERMISSIONS.map((permission) => permission.key));

/** Narrows a raw database string to a `PermissionKey` only if it is still in the catalog. */
function isPermissionKey(key: string): key is PermissionKey {
  return CATALOG_KEYS.has(key);
}

/**
 * Loads the flattened permission set granted to a user through their roles.
 *
 * `Permission.key` is a plain unique string column: nothing in the database
 * guarantees it still matches a current catalog entry. A role can keep
 * pointing at a permission that was later renamed or removed from
 * `PERMISSIONS`, so the keys read back are filtered against the catalog here
 * rather than cast — the return type is true by construction, and a stale key
 * the code no longer checks is correctly dropped: it grants nothing.
 */
export async function loadActorPermissions(db: Db, userId: string): Promise<PermissionKey[]> {
  const rows = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
  });

  const keys = new Set<string>();
  for (const row of rows) {
    for (const link of row.role.permissions) keys.add(link.permission.key);
  }
  return [...keys].filter(isPermissionKey);
}

/**
 * Gate every write path on this. Customers never hold staff permissions:
 * their routes are separate and must not go through the permission table.
 */
export function requirePermission(actor: Actor | null, permission: PermissionKey): Result<Actor> {
  if (!actor || actor.type !== 'STAFF' || !actor.permissions.includes(permission)) {
    return fail('PERMISSION_DENIED', { permission });
  }
  return ok(actor);
}
