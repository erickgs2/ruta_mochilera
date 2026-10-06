import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { StorageProvider } from '@rm/storage';
import { getCustomerProfile, setCustomerPhoto, updateCustomerProfile } from './customer-profile';

const db = withTestDb();

/** In-memory `StorageProvider` double, same shape as the one in `trip-image-service.spec.ts`. */
function fakeStorage(): StorageProvider & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
      return { key, contentType: 'image/png', sizeBytes: body.byteLength };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`not found: ${key}`);
      return value;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    publicUrl(key) {
      return `http://localhost/api/v1/files/${key}`;
    },
  };
}

async function seedCustomer(email = 'ana@example.com') {
  return db.user.create({
    data: {
      email,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: { fullName: 'Ana Pérez', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
      },
    },
  });
}

async function seedStaff() {
  return db.user.create({
    data: { email: 'staff@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Staff' } } },
  });
}

const png = { buffer: Buffer.from('fake-png'), contentType: 'image/png', extension: 'png' };

describe('customer profile', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  it('reads name, phone, email and no photo for a fresh customer', async () => {
    const user = await seedCustomer();

    const result = await getCustomerProfile(db, fakeStorage(), user.id);

    expect(result).toEqual({
      ok: true,
      value: { fullName: 'Ana Pérez', phone: '5512345678', email: 'ana@example.com', photoUrl: null },
    });
  });

  it('updates the name and the phone, and only those', async () => {
    const user = await seedCustomer();

    const result = await updateCustomerProfile(db, fakeStorage(), user.id, { fullName: 'Ana P. López', phone: '5598765432' });

    expect(result.ok && result.value).toMatchObject({ fullName: 'Ana P. López', phone: '5598765432', email: 'ana@example.com' });
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id }, include: { customerProfile: true } });
    expect(stored.email).toBe('ana@example.com');
    expect(stored.customerProfile?.birthDate.toISOString().slice(0, 10)).toBe('1990-01-01');
  });

  it('leaves a field untouched when it is not sent', async () => {
    const user = await seedCustomer();

    await updateCustomerProfile(db, fakeStorage(), user.id, { phone: '5500000000' });

    const stored = await db.customerProfile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.fullName).toBe('Ana Pérez');
    expect(stored.phone).toBe('5500000000');
  });

  it('stores a new photo under a key of its own, serves its URL, and removes the previous one', async () => {
    const user = await seedCustomer();
    const storage = fakeStorage();

    const first = await setCustomerPhoto(db, storage, user.id, png);
    expect(first.ok).toBe(true);
    const firstKey = (await db.customerProfile.findUniqueOrThrow({ where: { userId: user.id } })).photoKey;
    expect(firstKey).toMatch(new RegExp(`^customers/${user.id}/[0-9a-f-]+\\.png$`));
    expect(first.ok && first.value.photoUrl).toBe(`http://localhost/api/v1/files/${firstKey}`);

    await setCustomerPhoto(db, storage, user.id, png);
    const secondKey = (await db.customerProfile.findUniqueOrThrow({ where: { userId: user.id } })).photoKey;
    expect(secondKey).not.toBe(firstKey);
    expect(storage.objects.has(firstKey ?? '')).toBe(false);
    expect(storage.objects.has(secondKey ?? '')).toBe(true);
  });

  it('answers NOT_FOUND for a staff user, who has no customer profile', async () => {
    const staff = await seedStaff();
    const storage = fakeStorage();

    expect(await getCustomerProfile(db, storage, staff.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND', details: undefined } });
    expect((await updateCustomerProfile(db, storage, staff.id, { phone: '5500000000' })).ok).toBe(false);
    expect((await setCustomerPhoto(db, storage, staff.id, png)).ok).toBe(false);
    expect(storage.objects.size).toBe(0);
  });
});
