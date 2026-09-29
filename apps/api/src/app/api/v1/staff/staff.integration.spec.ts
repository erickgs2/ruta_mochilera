import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword } from '@rm/domain-identity';
import { POST as loginRoute } from '../auth/login/route';
import { GET as listStaffRoute, POST as createStaffRoute } from './route';
import { PUT as updateStaffRoute } from './[userId]/route';

const db = withTestDb();

function withUserId(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

/**
 * Seeds a staff user holding exactly the given permission keys and logs in,
 * returning the resulting access token. Every permission requested here is
 * expected to already exist in the seeded catalog (`staff.view`, `staff.manage`).
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

  const response = await loginRoute(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-Horse-1' }),
    })
  );
  const body = await response.json();
  return body.tokens.accessToken;
}

async function seedPermissionCatalog() {
  await db.permission.createMany({
    data: [
      { key: 'staff.view', category: 'staff', description: 'View administrator accounts' },
      { key: 'staff.manage', category: 'staff', description: 'Create, edit and disable administrator accounts' },
    ],
  });
}

const createBody = {
  email: 'nuevo@agency.test',
  fullName: 'Nuevo Empleado',
  locale: 'es' as const,
  password: 'Initial-Pass-1',
  roleIds: [] as string[],
};

describe('staff endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog();
  });

  afterAll(() => closeTestDb());

  describe('POST /api/v1/staff', () => {
    it('succeeds for an actor holding staff.manage', async () => {
      const token = await loginAs('manager@agency.test', ['staff.manage']);

      const response = await createStaffRoute(
        new Request('http://localhost/api/v1/staff', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(createBody),
        })
      );

      expect(response.status).toBe(201);
      expect((await response.json()).email).toBe('nuevo@agency.test');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only staff.view', async () => {
      const token = await loginAs('viewer@agency.test', ['staff.view']);

      const response = await createStaffRoute(
        new Request('http://localhost/api/v1/staff', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(createBody),
        })
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await createStaffRoute(
        new Request('http://localhost/api/v1/staff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(createBody),
        })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/staff', () => {
    it('succeeds for an actor holding staff.view', async () => {
      const token = await loginAs('viewer@agency.test', ['staff.view']);
      const response = await listStaffRoute(
        new Request('http://localhost/api/v1/staff', { headers: { authorization: `Bearer ${token}` } })
      );
      expect(response.status).toBe(200);
    });

    it('returns 403 PERMISSION_DENIED for an authenticated actor without staff.view', async () => {
      const token = await loginAs('nobody@agency.test', []);
      const response = await listStaffRoute(
        new Request('http://localhost/api/v1/staff', { headers: { authorization: `Bearer ${token}` } })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await listStaffRoute(new Request('http://localhost/api/v1/staff'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });

  describe('PUT /api/v1/staff/:userId', () => {
    async function seedTargetStaff(): Promise<string> {
      const user = await db.user.create({
        data: {
          email: 'target@agency.test',
          type: 'STAFF',
          passwordHash: await hashPassword('Correct-Horse-1'),
          emailVerifiedAt: new Date(),
          staffProfile: { create: { fullName: 'Target Employee' } },
        },
      });
      return user.id;
    }

    const updateBody = {
      fullName: 'Target Employee 2',
      locale: 'en' as const,
      status: 'ACTIVE' as const,
      roleIds: [] as string[],
    };

    it('succeeds for an actor holding staff.manage', async () => {
      const userId = await seedTargetStaff();
      const token = await loginAs('manager@agency.test', ['staff.manage']);

      const response = await updateStaffRoute(
        new Request(`http://localhost/api/v1/staff/${userId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(updateBody),
        }),
        withUserId(userId)
      );

      expect(response.status).toBe(200);
      expect((await response.json()).fullName).toBe('Target Employee 2');
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only staff.view', async () => {
      const userId = await seedTargetStaff();
      const token = await loginAs('viewer@agency.test', ['staff.view']);

      const response = await updateStaffRoute(
        new Request(`http://localhost/api/v1/staff/${userId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(updateBody),
        }),
        withUserId(userId)
      );

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const userId = await seedTargetStaff();

      const response = await updateStaffRoute(
        new Request(`http://localhost/api/v1/staff/${userId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(updateBody),
        }),
        withUserId(userId)
      );

      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
