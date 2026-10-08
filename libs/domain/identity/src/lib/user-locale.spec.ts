import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { updateOwnLocale } from './user-locale';

const db = withTestDb();

async function seedUser(type: 'STAFF' | 'CUSTOMER', email: string, locale: 'es' | 'en' = 'es') {
  return db.user.create({
    data: {
      email,
      type,
      locale,
      ...(type === 'STAFF'
        ? { staffProfile: { create: { fullName: 'Persona de personal' } } }
        : {
            emailVerifiedAt: new Date(),
            customerProfile: { create: { fullName: 'Ana Pérez', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' } },
          }),
    },
  });
}

describe('updateOwnLocale', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  it.each(['STAFF', 'CUSTOMER'] as const)('saves the chosen language of a %s user and returns the user as the session sees them', async (type) => {
    const user = await seedUser(type, 'someone@agency.test', 'es');

    const result = await updateOwnLocale(db, user.id, 'en');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ id: user.id, email: 'someone@agency.test', type, locale: 'en' });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBe('en');
  });

  it('can switch back, and saving the language already stored changes nothing', async () => {
    const user = await seedUser('CUSTOMER', 'ana@agency.test', 'en');

    expect((await updateOwnLocale(db, user.id, 'en')).ok).toBe(true);
    expect((await updateOwnLocale(db, user.id, 'es')).ok).toBe(true);

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBe('es');
  });

  it("only ever touches the caller's own row", async () => {
    const caller = await seedUser('STAFF', 'caller@agency.test', 'es');
    const other = await seedUser('CUSTOMER', 'other@agency.test', 'es');

    await updateOwnLocale(db, caller.id, 'en');

    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).locale).toBe('es');
  });

  it('answers NOT_FOUND for a user that no longer exists', async () => {
    const result = await updateOwnLocale(db, '00000000-0000-0000-0000-000000000000', 'en');
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
