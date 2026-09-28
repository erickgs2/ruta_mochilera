import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loadActorPermissions } from './access';
import { PERMISSIONS } from './permissions';

const db = withTestDb();

describe('loadActorPermissions', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('omits a permission row whose key is no longer in the catalog', async () => {
    const liveDefinition = PERMISSIONS[0];

    // Simulates a permission that used to exist in the catalog and was later
    // renamed or removed: the row (and a role still linked to it) survives in
    // the database even though `PERMISSIONS` no longer lists the key. The
    // test database only has whatever this test inserts, so the "live"
    // permission is created here too rather than assumed to be seeded.
    const stale = await db.permission.create({
      data: { key: 'legacy.removed_permission', category: 'legacy', description: 'No longer in the catalog' },
    });
    const live = await db.permission.create({ data: liveDefinition });

    const role = await db.role.create({
      data: { name: 'Stale Grant Role', description: 'Holds a permission removed from the catalog' },
    });
    await db.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: stale.id },
        { roleId: role.id, permissionId: live.id },
      ],
    });

    const user = await db.user.create({
      data: { email: 'stale-grant@agency.test', type: 'STAFF' },
    });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const permissions = await loadActorPermissions(db, user.id);

    expect(permissions).toEqual([liveDefinition.key]);
    expect(permissions).not.toContain('legacy.removed_permission');
  });
});
