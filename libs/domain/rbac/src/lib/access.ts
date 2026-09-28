import type { Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { PermissionKey } from './permissions';

export interface Actor {
  userId: string;
  type: 'STAFF' | 'CUSTOMER';
  locale: 'es' | 'en';
  permissions: readonly PermissionKey[];
}

/** Loads the flattened permission set granted to a user through their roles. */
export async function loadActorPermissions(db: Db, userId: string): Promise<PermissionKey[]> {
  const rows = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
  });

  const keys = new Set<string>();
  for (const row of rows) {
    for (const link of row.role.permissions) keys.add(link.permission.key);
  }
  return [...keys] as PermissionKey[];
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
