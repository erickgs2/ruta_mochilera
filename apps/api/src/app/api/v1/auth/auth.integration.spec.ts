import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword } from '@rm/domain-identity';
import { POST as loginRoute } from './login/route';
import { POST as refreshRoute } from './refresh/route';
import { GET as meRoute } from '../me/route';

const db = withTestDb();

const post = (handler: typeof loginRoute, body: unknown) =>
  handler(new Request('http://localhost/api/v1/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

async function seedAdmin() {
  const permission = await db.permission.create({
    data: { key: 'trip.view', category: 'trips', description: 'View trips' },
  });
  const role = await db.role.create({ data: { name: 'Viewer', description: 'Read only' } });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  await db.user.create({
    data: {
      email: 'admin@agency.test',
      type: 'STAFF',
      passwordHash: await hashPassword('Correct-Horse-1'),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: 'Admin' } },
      roles: { create: { roleId: role.id } },
    },
  });
}

describe('auth endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeTestDb());

  it('logs in and returns the session payload', async () => {
    await seedAdmin();
    const response = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.permissions).toEqual(['trip.view']);
    expect(body.tokens.refreshToken).toBeTruthy();
  });

  it('returns 401 problem+json on bad credentials', async () => {
    await seedAdmin();
    const response = await post(loginRoute, { email: 'admin@agency.test', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 422 when the body fails validation', async () => {
    const response = await post(loginRoute, { email: 'not-an-email' });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects /me without a token', async () => {
    const response = await meRoute(new Request('http://localhost/api/v1/me'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('TOKEN_INVALID');
  });

  it('returns the profile for an authenticated caller', async () => {
    await seedAdmin();
    const login = await (await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' })).json();

    const response = await meRoute(
      new Request('http://localhost/api/v1/me', {
        headers: { authorization: `Bearer ${login.tokens.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).email).toBe('admin@agency.test');
  });

  it('rejects a replayed refresh token with 401 TOKEN_REUSED', async () => {
    await seedAdmin();
    const login = await (await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' })).json();

    await post(refreshRoute, { refreshToken: login.tokens.refreshToken });
    const replay = await post(refreshRoute, { refreshToken: login.tokens.refreshToken });

    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe('TOKEN_REUSED');
  });
});
