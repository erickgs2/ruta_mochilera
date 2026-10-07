import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { LocalFileStorage } from '@rm/storage';
import { setStorage } from '../../../../../lib/storage';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { POST as uploadPhotoRoute } from './photo/route';
import { GET as getProfileRoute, PATCH as patchProfileRoute } from './route';

const db = withTestDb();

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function request(token: string | undefined, init: RequestInit = {}) {
  return new Request('http://localhost/api/v1/me/profile', {
    ...init,
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function photoRequest(token: string | undefined, file: File) {
  const form = new FormData();
  form.set('file', file);
  return new Request('http://localhost/api/v1/me/profile/photo', {
    method: 'POST',
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function patch(token: string, body: unknown) {
  return patchProfileRoute(request(token, { method: 'PATCH', body: JSON.stringify(body) }));
}

describe('customer profile endpoints', () => {
  let storageRoot: string;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    storageRoot = mkdtempSync(join(tmpdir(), 'rm-profile-test-'));
    setStorage(new LocalFileStorage(storageRoot, 'http://localhost/api/v1/files'));
  });
  afterEach(() => {
    setStorage(undefined);
    rmSync(storageRoot, { recursive: true, force: true });
  });
  afterAll(() => closeTestDb());

  describe('GET /api/v1/me/profile', () => {
    it("returns the caller's own name, phone, email and photo URL", async () => {
      const { token } = await loginAsCustomer(db, 'ana-profile@agency.test');

      const response = await getProfileRoute(request(token));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        fullName: 'ana-profile@agency.test',
        phone: '5512345678',
        email: 'ana-profile@agency.test',
        photoUrl: null,
      });
    });

    it('returns 401 without a token', async () => {
      const response = await getProfileRoute(request(undefined));
      expect(response.status).toBe(401);
    });

    it('returns 404 for a staff user, who has no customer profile', async () => {
      await seedPermissionCatalog(db);
      const token = await loginAs(db, 'staff-profile@agency.test', []);

      const response = await getProfileRoute(request(token));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/me/profile', () => {
    it('changes the name and the phone', async () => {
      const { token } = await loginAsCustomer(db, 'ana-patch@agency.test');

      const response = await patch(token, { fullName: 'Ana López', phone: '5598765432' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.fullName).toBe('Ana López');
      expect(body.phone).toBe('5598765432');
    });

    it('refuses an email with 422 instead of ignoring it, and leaves the email untouched', async () => {
      const { token, userId } = await loginAsCustomer(db, 'ana-email@agency.test');

      const response = await patch(token, { fullName: 'Ana López', email: 'someone-else@example.com' });

      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
      const stored = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { customerProfile: true } });
      expect(stored.email).toBe('ana-email@agency.test');
      expect(stored.customerProfile?.fullName).toBe('ana-email@agency.test');
    });

    it('applies the registration limits: a two-letter name or a five-digit phone is refused', async () => {
      const { token } = await loginAsCustomer(db, 'ana-limits@agency.test');

      expect((await patch(token, { fullName: 'Al' })).status).toBe(422);
      expect((await patch(token, { phone: '12345' })).status).toBe(422);
    });
  });

  describe('POST /api/v1/me/profile/photo', () => {
    it("stores the photo under the caller's own key and answers with its URL", async () => {
      const { token, userId } = await loginAsCustomer(db, 'ana-photo@agency.test');

      const response = await uploadPhotoRoute(photoRequest(token, new File([PNG_BYTES], 'me.png', { type: 'image/png' })));

      expect(response.status).toBe(200);
      const body = await response.json();
      const stored = await db.customerProfile.findUniqueOrThrow({ where: { userId } });
      expect(stored.photoKey).toMatch(new RegExp(`^customers/${userId}/[0-9a-f-]+\\.png$`));
      expect(body.photoUrl).toBe(`http://localhost/api/v1/files/${stored.photoKey}`);
    });

    it('refuses a non-image labelled as an image, exactly like the trip gallery does', async () => {
      const { token } = await loginAsCustomer(db, 'ana-fake@agency.test');

      const response = await uploadPhotoRoute(
        photoRequest(token, new File(['<script>alert(1)</script>'], 'me.png', { type: 'image/png' }))
      );

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ field: 'contentType' });
    });

    it('refuses a file above the shared size limit', async () => {
      const { token } = await loginAsCustomer(db, 'ana-big@agency.test');
      const big = new Uint8Array(8 * 1024 * 1024 + 1);
      big.set(PNG_BYTES);

      const response = await uploadPhotoRoute(photoRequest(token, new File([big], 'big.png', { type: 'image/png' })));

      expect(response.status).toBe(422);
      expect((await response.json()).details).toMatchObject({ field: 'size' });
    });

    it('returns 401 without a token', async () => {
      const response = await uploadPhotoRoute(photoRequest(undefined, new File([PNG_BYTES], 'me.png')));
      expect(response.status).toBe(401);
    });
  });
});
