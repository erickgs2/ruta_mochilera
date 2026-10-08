import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../test-support/auth-fixtures';
import { GET as getMeRoute, PATCH as patchMeRoute } from './route';

const db = withTestDb();

function request(token: string | undefined, init: RequestInit = {}) {
  return new Request('http://localhost/api/v1/me', {
    ...init,
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function patch(token: string | undefined, body: unknown) {
  return patchMeRoute(request(token, { method: 'PATCH', body: JSON.stringify(body) }));
}

const localeOf = async (email: string) => (await db.user.findUniqueOrThrow({ where: { email } })).locale;

describe('PATCH /api/v1/me (own language)', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('answers 401 without a token', async () => {
    const response = await patch(undefined, { locale: 'en' });
    expect(response.status).toBe(401);
  });

  it('saves the language of a staff user with no permission at all, and GET /me returns it', async () => {
    const token = await loginAs(db, 'staff@agency.test', []);
    expect(await localeOf('staff@agency.test')).toBe('es');

    const response = await patch(token, { locale: 'en' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'staff@agency.test', type: 'STAFF', locale: 'en' });
    expect(await localeOf('staff@agency.test')).toBe('en');
    const me = await getMeRoute(request(token));
    expect((await me.json()).locale).toBe('en');
  });

  it('saves the language of a customer too', async () => {
    const { token } = await loginAsCustomer(db, 'customer@agency.test');

    const response = await patch(token, { locale: 'en' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'customer@agency.test', type: 'CUSTOMER', locale: 'en' });
    expect(await localeOf('customer@agency.test')).toBe('en');
  });

  it("never touches another user: there is no id to send, and an unknown field is refused", async () => {
    const token = await loginAs(db, 'caller@agency.test', []);
    const other = await loginAsCustomer(db, 'other@agency.test');

    const response = await patch(token, { locale: 'en', userId: other.userId });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await localeOf('other@agency.test')).toBe('es');
    expect(await localeOf('caller@agency.test')).toBe('es');
  });

  it.each([
    ['a language that does not exist', { locale: 'fr' }],
    ['no locale at all', {}],
    ['a locale that is not text', { locale: 1 }],
    ['another profile field', { locale: 'en', email: 'x@y.test' }],
  ])('answers 422 VALIDATION_FAILED for %s, saving nothing', async (_label, body) => {
    const token = await loginAs(db, 'caller@agency.test', []);

    const response = await patch(token, body);

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await localeOf('caller@agency.test')).toBe('es');
  });
});
