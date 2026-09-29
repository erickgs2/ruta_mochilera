import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword } from '@rm/domain-identity';
import { POST as loginRoute } from '../auth/login/route';
import { GET as getPermissions } from './permissions/route';
import { GET as listRolesRoute, POST as createRoleRoute } from './roles/route';
import { DELETE as deleteRoleRoute, PUT as updateRoleRoute } from './roles/[roleId]/route';

const db = withTestDb();

function post(handler: typeof loginRoute, body: unknown, token?: string) {
  return handler(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

function get(handler: typeof getPermissions, token?: string) {
  return handler(
    new Request('http://localhost/api/v1/rbac', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  );
}

function withRoleId(roleId: string) {
  return { params: Promise.resolve({ roleId }) };
}

/**
 * Seeds a staff user holding exactly the given permission keys and logs in,
 * returning the resulting access token. Every permission requested here is
 * expected to already exist in the seeded catalog (`role.view`, `role.manage`).
 */
async function loginAs(email: string, permissionKeys: string[]): Promise<string> {
  const role = await db.role.create({ data: { name: `role-for-${email}`, description: 'test role' } });
  const permissions = await db.permission.findMany({ where: { key: { in: permissionKeys } } });
  await db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  await db.user.create({
    data: {
      email,
      type: 'STAFF',
      passwordHash: await hashPassword('Correct-Horse-1'),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: email } },
      roles: { create: { roleId: role.id } },
    },
  });

  const response = await post(loginRoute, { email, password: 'Correct-Horse-1' });
  const body = await response.json();
  return body.tokens.accessToken;
}

async function seedPermissionCatalog() {
  await db.permission.createMany({
    data: [
      { key: 'role.view', category: 'rbac', description: 'View roles and the permission catalog' },
      { key: 'role.manage', category: 'rbac', description: 'Create, edit and delete roles' },
    ],
  });
}

describe('rbac endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog();
  });

  afterAll(() => closeTestDb());

  describe('POST /api/v1/rbac/roles', () => {
    it('succeeds for an actor holding role.manage', async () => {
      const token = await loginAs('manager@agency.test', ['role.manage']);

      const response = await createRoleRoute(
        new Request('http://localhost/api/v1/rbac/roles', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'Seller', description: 'Sells trips', permissionKeys: [] }),
        })
      );

      expect(response.status).toBe(201);
      expect((await response.json()).name).toBe('Seller');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only role.view', async () => {
      const token = await loginAs('viewer@agency.test', ['role.view']);

      const response = await createRoleRoute(
        new Request('http://localhost/api/v1/rbac/roles', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'Seller', description: 'Sells trips', permissionKeys: [] }),
        })
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await createRoleRoute(
        new Request('http://localhost/api/v1/rbac/roles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Seller', description: 'Sells trips', permissionKeys: [] }),
        })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/rbac/roles', () => {
    it('succeeds for an actor holding role.view', async () => {
      const token = await loginAs('viewer@agency.test', ['role.view']);
      const response = await listRolesRoute(
        new Request('http://localhost/api/v1/rbac/roles', { headers: { authorization: `Bearer ${token}` } })
      );
      expect(response.status).toBe(200);
    });

    it('returns 403 PERMISSION_DENIED for an authenticated actor without role.view', async () => {
      // Closes the same gap Task 8's review found in the wrapper itself,
      // reappearing here one route at a time: without this case, deleting
      // `permission: 'role.view'` from this route would not fail a single
      // test.
      const token = await loginAs('nobody@agency.test', []);
      const response = await listRolesRoute(
        new Request('http://localhost/api/v1/rbac/roles', { headers: { authorization: `Bearer ${token}` } })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await listRolesRoute(new Request('http://localhost/api/v1/rbac/roles'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/rbac/permissions', () => {
    it('succeeds for an actor holding role.view', async () => {
      // Without this positive case, the route could require the wrong
      // permission key entirely and every other test here would still pass.
      const token = await loginAs('viewer@agency.test', ['role.view']);
      const response = await get(getPermissions, token);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'role.view' })])
      );
    });

    it('returns 403 PERMISSION_DENIED for an actor with no rbac permission at all', async () => {
      const token = await loginAs('nobody@agency.test', []);
      const response = await get(getPermissions, token);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await get(getPermissions);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT and DELETE /api/v1/rbac/roles/:roleId', () => {
    async function seedTargetRole(): Promise<string> {
      const role = await db.role.create({ data: { name: 'Seller', description: 'Sells trips' } });
      return role.id;
    }

    it('PUT succeeds for an actor holding role.manage', async () => {
      const roleId = await seedTargetRole();
      const token = await loginAs('manager@agency.test', ['role.manage']);

      const response = await updateRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'Seller 2', description: 'x', permissionKeys: [] }),
        }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(200);
      expect((await response.json()).name).toBe('Seller 2');
    });

    it('PUT returns 403 PERMISSION_DENIED for an actor holding only role.view', async () => {
      const roleId = await seedTargetRole();
      const token = await loginAs('viewer@agency.test', ['role.view']);

      const response = await updateRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'Seller 2', description: 'x', permissionKeys: [] }),
        }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('PUT returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const roleId = await seedTargetRole();

      const response = await updateRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Seller 2', description: 'x', permissionKeys: [] }),
        }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('DELETE succeeds for an actor holding role.manage', async () => {
      const roleId = await seedTargetRole();
      const token = await loginAs('manager@agency.test', ['role.manage']);

      const response = await deleteRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(204);
    });

    it('DELETE returns 403 PERMISSION_DENIED for an actor holding only role.view', async () => {
      const roleId = await seedTargetRole();
      const token = await loginAs('viewer@agency.test', ['role.view']);

      const response = await deleteRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('DELETE returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const roleId = await seedTargetRole();

      const response = await deleteRoleRoute(
        new Request(`http://localhost/api/v1/rbac/roles/${roleId}`, { method: 'DELETE' }),
        withRoleId(roleId)
      );

      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
