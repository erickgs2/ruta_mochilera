import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { verifyPassword } from '@rm/domain-identity';
import type { Actor } from '@rm/domain-rbac';
import { createStaff, listStaff, updateStaff } from './staff-service';

const db = withTestDb();
const actor: Actor = {
  userId: '11111111-1111-1111-1111-111111111111',
  type: 'STAFF',
  locale: 'es',
  permissions: ['staff.manage'],
};

const baseInput = {
  email: 'nuevo@agency.test',
  fullName: 'Nuevo Empleado',
  locale: 'es' as const,
  password: 'Initial-Pass-1',
  roleIds: [] as string[],
};

describe('staff service', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  it('creates a staff user with a verified email and hashed password', async () => {
    const result = await createStaff(db, actor, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db.user.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(row.type).toBe('STAFF');
    // An administrator created by another administrator does not verify
    // their email: the account is born trusted.
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBe('Initial-Pass-1');
    expect(await verifyPassword(row.passwordHash!, 'Initial-Pass-1')).toBe(true);
  });

  it('normalises the email to lowercase', async () => {
    const result = await createStaff(db, actor, { ...baseInput, email: 'Nuevo@Agency.TEST' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe('nuevo@agency.test');
  });

  it('rejects a duplicate email regardless of case', async () => {
    await createStaff(db, actor, baseInput);
    const result = await createStaff(db, actor, { ...baseInput, email: 'NUEVO@agency.test' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects an email that collides only once the database enforces it', async () => {
    // Simulates two concurrent creates for the same email racing past the
    // application-level pre-check (both see no existing row) before either
    // has inserted: the unique index is the backstop that must still produce
    // EMAIL_ALREADY_REGISTERED instead of an unhandled Prisma error
    // surfacing as a 500. Mirrors `role-service.spec.ts`'s equivalent test
    // for role names.
    const originalFindFirst = db.user.findFirst.bind(db.user);
    const findFirstSpy = vi.spyOn(db.user, 'findFirst').mockImplementation(
      (async (args: Parameters<typeof db.user.findFirst>[0]) => {
        const result = await originalFindFirst(args);
        if ((args?.where?.email as { equals?: string } | undefined)?.equals === baseInput.email) {
          await db.user.create({
            data: {
              email: baseInput.email,
              type: 'STAFF',
              staffProfile: { create: { fullName: 'Racer' } },
            },
          });
        }
        return result;
      }) as unknown as typeof db.user.findFirst
    );

    try {
      const result = await createStaff(db, actor, baseInput);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    } finally {
      findFirstSpy.mockRestore();
    }
  });

  it('assigns the requested roles', async () => {
    const role = await db.role.create({ data: { name: 'Seller', description: 'x' } });
    const result = await createStaff(db, actor, { ...baseInput, roleIds: [role.id] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.roleIds).toEqual([role.id]);
  });

  it('rejects an unknown role id', async () => {
    const result = await createStaff(db, actor, {
      ...baseInput,
      roleIds: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('disables an account and replaces its roles on update', async () => {
    const roleA = await db.role.create({ data: { name: 'A', description: 'x' } });
    const roleB = await db.role.create({ data: { name: 'B', description: 'x' } });
    const created = await createStaff(db, actor, { ...baseInput, roleIds: [roleA.id] });
    if (!created.ok) throw new Error('setup failed');

    const updated = await updateStaff(db, actor, created.value.id, {
      fullName: 'Nuevo Empleado',
      locale: 'en',
      status: 'DISABLED',
      roleIds: [roleB.id],
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.status).toBe('DISABLED');
    expect(updated.value.locale).toBe('en');
    expect(updated.value.roleIds).toEqual([roleB.id]);
  });

  it('revokes every live session when an account is disabled', async () => {
    const created = await createStaff(db, actor, baseInput);
    if (!created.ok) throw new Error('setup failed');
    await db.refreshToken.create({
      data: {
        userId: created.value.id,
        sessionId: '11111111-1111-1111-1111-111111111111',
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await updateStaff(db, actor, created.value.id, {
      fullName: 'Nuevo Empleado', locale: 'es', status: 'DISABLED', roleIds: [],
    });

    expect(await db.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('searches by name and by email', async () => {
    await createStaff(db, actor, baseInput);
    await createStaff(db, actor, { ...baseInput, email: 'otra@agency.test', fullName: 'Otra Persona' });

    const byName = await listStaff(db, { search: 'otra' });
    expect(byName.ok && byName.value).toHaveLength(1);

    const byEmail = await listStaff(db, { search: 'nuevo@' });
    expect(byEmail.ok && byEmail.value).toHaveLength(1);

    const all = await listStaff(db, {});
    expect(all.ok && all.value).toHaveLength(2);
  });

  it('never returns customers in the staff list', async () => {
    await db.user.create({
      data: {
        email: 'cliente@mail.test',
        type: 'CUSTOMER',
        customerProfile: {
          create: { fullName: 'Cliente', phone: '5550000000', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
        },
      },
    });
    const result = await listStaff(db, {});
    expect(result.ok && result.value).toHaveLength(0);
  });
});
