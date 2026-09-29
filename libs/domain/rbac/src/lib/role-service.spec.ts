import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Actor } from './access';
import { createRole, deleteRole, listRoles, updateRole } from './role-service';

const db = withTestDb();
const actor: Actor = { userId: '11111111-1111-1111-1111-111111111111', type: 'STAFF', locale: 'es', permissions: ['role.manage'] };

async function seedPermissions() {
  await db.permission.createMany({
    data: [
      { key: 'trip.view', category: 'trips', description: 'View trips' },
      { key: 'trip.create', category: 'trips', description: 'Create trips' },
    ],
  });
}

describe('role service', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissions();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('creates a role with its permissions', async () => {
    const result = await createRole(db, actor, {
      name: 'Seller',
      description: 'Sells trips',
      permissionKeys: ['trip.view', 'trip.create'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionKeys.sort()).toEqual(['trip.create', 'trip.view']);
    expect(result.value.isSystem).toBe(false);
    expect(result.value.userCount).toBe(0);
  });

  it('rejects an unknown permission key', async () => {
    const result = await createRole(db, actor, {
      name: 'Ghost',
      description: 'x',
      permissionKeys: ['trip.view', 'does.not_exist'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.details).toEqual({ unknownPermissions: ['does.not_exist'] });
    }
  });

  it('rejects a duplicate role name', async () => {
    await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: [] });
    const result = await createRole(db, actor, { name: 'Seller', description: 'y', permissionKeys: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
  });

  it('replaces the permission set on update', async () => {
    const created = await createRole(db, actor, {
      name: 'Seller',
      description: 'x',
      permissionKeys: ['trip.view', 'trip.create'],
    });
    if (!created.ok) throw new Error('setup failed');

    const updated = await updateRole(db, actor, created.value.id, {
      name: 'Seller',
      description: 'x',
      permissionKeys: ['trip.view'],
    });

    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.permissionKeys).toEqual(['trip.view']);
  });

  it('refuses to modify or delete a system role', async () => {
    const role = await db.role.create({
      data: { name: 'Super Admin', description: 'All', isSystem: true },
    });

    const updated = await updateRole(db, actor, role.id, { name: 'Hacked', description: 'x', permissionKeys: [] });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');

    const removed = await deleteRole(db, actor, role.id);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
  });

  it('refuses to delete a role that still has users', async () => {
    const created = await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: [] });
    if (!created.ok) throw new Error('setup failed');

    const user = await db.user.create({ data: { email: 'u@agency.test', type: 'STAFF' } });
    await db.userRole.create({ data: { userId: user.id, roleId: created.value.id } });

    const result = await deleteRole(db, actor, created.value.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ROLE_IN_USE');
  });

  it('refuses to delete a role when a user is assigned between the pre-check and the delete', async () => {
    // Reproduces the race the ROLE_IN_USE pre-check alone cannot close: a
    // `UserRole` is inserted for this role immediately after `deleteRole`'s
    // own pre-check has already read zero users, so the pre-check is fooled
    // and would let the delete proceed. `findUnique` is spied (rather than
    // raced with real concurrent promises) so the interleaving is exact and
    // does not depend on which operation happens to resolve first -- the
    // point of this test is the database's own `Restrict` foreign key, not
    // scheduler luck.
    const created = await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: [] });
    if (!created.ok) throw new Error('setup failed');

    // `mockImplementation` must accept a plain async function here, but
    // `db.role.findUnique`'s real type returns Prisma's fluent
    // `Prisma__RoleClient` (a promise with extra relation-loading methods),
    // which no ordinary `async` function can structurally satisfy. The cast
    // is the standard escape for mocking a Prisma delegate method; it does
    // not touch any of the `Db`/`DbTransactionClient` typing this task's
    // rulings are about.
    const originalFindUnique = db.role.findUnique.bind(db.role);
    const findUniqueSpy = vi.spyOn(db.role, 'findUnique').mockImplementation(
      (async (args: Parameters<typeof db.role.findUnique>[0]) => {
        const result = await originalFindUnique(args);
        if (args?.where?.id === created.value.id) {
          const racer = await db.user.create({ data: { email: 'racer@agency.test', type: 'STAFF' } });
          await db.userRole.create({ data: { userId: racer.id, roleId: created.value.id } });
        }
        return result;
      }) as unknown as typeof db.role.findUnique
    );

    let result: Awaited<ReturnType<typeof deleteRole>>;
    try {
      result = await deleteRole(db, actor, created.value.id);
    } finally {
      // Restored before any further `findUnique` calls in this test -- the
      // verification query below must not itself re-trigger the racer insert.
      findUniqueSpy.mockRestore();
    }

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ROLE_IN_USE');
      expect(result.error.details).toEqual({ userCount: 1 });
    }

    // The delete must have genuinely failed, not merely reported failure:
    // the role is still intact in the database.
    const stillExists = await db.role.findUnique({ where: { id: created.value.id } });
    expect(stillExists).not.toBeNull();
  });

  it('rejects a role name that collides only once the database enforces it', async () => {
    // Simulates two concurrent creates for the same name racing past the
    // application-level pre-check (both see no existing row) before either
    // has inserted: the unique index is the backstop that must still produce
    // CONFLICT instead of an unhandled Prisma error surfacing as a 500.
    // See the cast note in the previous test: `mockImplementation` requires
    // an exact structural match with Prisma's fluent client type, which a
    // plain `async` replacement never has.
    const originalFindUnique = db.role.findUnique.bind(db.role);
    const findUniqueSpy = vi.spyOn(db.role, 'findUnique').mockImplementation(
      (async (args: Parameters<typeof db.role.findUnique>[0]) => {
        const result = await originalFindUnique(args);
        if (args?.where?.name === 'Seller') {
          await db.role.create({ data: { name: 'Seller', description: 'racer' } });
        }
        return result;
      }) as unknown as typeof db.role.findUnique
    );

    try {
      const result = await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: [] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'CONFLICT', details: { field: 'name' } });
    } finally {
      findUniqueSpy.mockRestore();
    }
  });

  it('writes an audit entry for every mutation', async () => {
    const created = await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: [] });
    if (!created.ok) throw new Error('setup failed');
    await updateRole(db, actor, created.value.id, { name: 'Seller 2', description: 'x', permissionKeys: [] });

    const entries = await db.auditLog.findMany({ where: { entityType: 'Role' }, orderBy: { createdAt: 'asc' } });
    expect(entries.map((entry) => entry.action)).toEqual(['role.created', 'role.updated']);
    expect(entries[0].actorUserId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('lists roles with their user counts', async () => {
    const created = await createRole(db, actor, { name: 'Seller', description: 'x', permissionKeys: ['trip.view'] });
    if (!created.ok) throw new Error('setup failed');
    const user = await db.user.create({ data: { email: 'u@agency.test', type: 'STAFF' } });
    await db.userRole.create({ data: { userId: user.id, roleId: created.value.id } });

    const result = await listRoles(db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0].userCount).toBe(1);
  });
});
