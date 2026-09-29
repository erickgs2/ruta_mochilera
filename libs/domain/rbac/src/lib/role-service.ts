import { Prisma, uniqueViolationIndex, type Db } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { Actor } from './access';

export interface RoleDto {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissionKeys: string[];
  userCount: number;
}

export interface RoleInput {
  name: string;
  description: string;
  permissionKeys: string[];
}

const ROLE_SHAPE = {
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} as const;

type RoleRow = {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: { permission: { key: string } }[];
  _count: { users: number };
};

function toDto(role: RoleRow): RoleDto {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissionKeys: role.permissions.map((link) => link.permission.key).sort(),
    userCount: role._count.users,
  };
}

/** The unique index backing `Role.name` (see the `roles_name_key` migration). */
const ROLE_NAME_UNIQUE_INDEX = 'roles_name_key';

/**
 * Detects the race a pre-check name lookup cannot close: two concurrent
 * creates (or updates) for the same name can both pass the `findUnique`
 * check before either has inserted, so the database's unique index is the
 * final word, not just a nice-to-have. Without this, a genuine race surfaces
 * as an unhandled `PrismaClientKnownRequestError` and `route()`'s catch-all
 * turns it into an opaque `INTERNAL_ERROR` instead of the same `CONFLICT`
 * the pre-check returns.
 */
function isRoleNameConflict(error: unknown): boolean {
  return uniqueViolationIndex(error) === ROLE_NAME_UNIQUE_INDEX;
}

/**
 * Detects the race the `deleteRole` pre-check cannot close: a `UserRole`
 * inserted between the pre-check's count read and the delete below is
 * refused by the `user_roles_role_id_fkey` foreign key (`onDelete: Restrict`)
 * rather than silently cascade-deleted, which is what made the pre-check
 * alone unsafe. `P2003` is Prisma's code for a foreign-key constraint
 * violation.
 */
function isRoleInUseForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** Fails unless every requested key exists in the seeded permission catalog. */
async function resolvePermissionIds(db: Db, keys: string[]): Promise<Result<string[]>> {
  const found = await db.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  const missing = keys.filter((key) => !found.some((permission) => permission.key === key));
  if (missing.length > 0) return fail('VALIDATION_FAILED', { unknownPermissions: missing });
  return ok(found.map((permission) => permission.id));
}

export async function listRoles(db: Db): Promise<Result<RoleDto[]>> {
  const roles = await db.role.findMany({ include: ROLE_SHAPE, orderBy: { name: 'asc' } });
  return ok(roles.map(toDto));
}

export async function createRole(db: Db, actor: Actor, input: RoleInput): Promise<Result<RoleDto>> {
  if (await db.role.findUnique({ where: { name: input.name } })) {
    return fail('CONFLICT', { field: 'name' });
  }

  const permissionIds = await resolvePermissionIds(db, input.permissionKeys);
  if (!permissionIds.ok) return permissionIds;

  try {
    const role = await db.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          name: input.name,
          description: input.description,
          permissions: { create: permissionIds.value.map((permissionId) => ({ permissionId })) },
        },
        include: ROLE_SHAPE,
      });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'role.created',
        entityType: 'Role',
        entityId: created.id,
        after: { name: created.name, permissionKeys: input.permissionKeys },
      });
      return created;
    });

    return ok(toDto(role));
  } catch (error) {
    if (isRoleNameConflict(error)) return fail('CONFLICT', { field: 'name' });
    throw error;
  }
}

export async function updateRole(
  db: Db,
  actor: Actor,
  roleId: string,
  input: RoleInput
): Promise<Result<RoleDto>> {
  const existing = await db.role.findUnique({ where: { id: roleId }, include: ROLE_SHAPE });
  if (!existing) return fail('NOT_FOUND');
  if (existing.isSystem) return fail('SYSTEM_ROLE_IMMUTABLE');

  const conflict = await db.role.findFirst({ where: { name: input.name, id: { not: roleId } } });
  if (conflict) return fail('CONFLICT', { field: 'name' });

  const permissionIds = await resolvePermissionIds(db, input.permissionKeys);
  if (!permissionIds.ok) return permissionIds;

  try {
    const role = await db.$transaction(async (tx) => {
      // The permission set is replaced wholesale: the UI sends the final
      // state, not a diff, so the existing links are cleared before the new
      // ones are created rather than merged into them.
      await tx.rolePermission.deleteMany({ where: { roleId } });
      const updated = await tx.role.update({
        where: { id: roleId },
        data: {
          name: input.name,
          description: input.description,
          permissions: { create: permissionIds.value.map((permissionId) => ({ permissionId })) },
        },
        include: ROLE_SHAPE,
      });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'role.updated',
        entityType: 'Role',
        entityId: roleId,
        before: toDto(existing),
        after: { name: input.name, permissionKeys: input.permissionKeys },
      });
      return updated;
    });

    return ok(toDto(role));
  } catch (error) {
    if (isRoleNameConflict(error)) return fail('CONFLICT', { field: 'name' });
    throw error;
  }
}

export async function deleteRole(db: Db, actor: Actor, roleId: string): Promise<Result<null>> {
  const existing = await db.role.findUnique({ where: { id: roleId }, include: ROLE_SHAPE });
  if (!existing) return fail('NOT_FOUND');
  // Checked in this order -- and before the delete ever runs -- so a system
  // role can never be removed by first stripping its users and retrying:
  // immutability is checked independently of, and prior to, the in-use check.
  if (existing.isSystem) return fail('SYSTEM_ROLE_IMMUTABLE');
  if (existing._count.users > 0) return fail('ROLE_IN_USE', { userCount: existing._count.users });

  try {
    await db.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: roleId } });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'role.deleted',
        entityType: 'Role',
        entityId: roleId,
        before: toDto(existing),
      });
    });
  } catch (error) {
    if (isRoleInUseForeignKeyViolation(error)) {
      // The failed transaction has already rolled back, so this read
      // reflects what is actually in the database now (the assignment that
      // won the race), not the stale, pre-race count read by the pre-check
      // above.
      const userCount = await db.userRole.count({ where: { roleId } });
      return fail('ROLE_IN_USE', { userCount });
    }
    throw error;
  }

  return ok(null);
}
