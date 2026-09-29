import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { LocalFileStorage } from '@rm/storage';
import { setStorage, storage } from '../../../../../../lib/storage';
import { loginAs, seedPermissionCatalog } from '../../../../../../test-support/auth-fixtures';
import { POST as createTripRoute } from '../../route';
import { DELETE as deleteImageRoute } from './[imageId]/route';
import { POST as uploadImageRoute } from './route';

const db = withTestDb();

function withParams(tripId: string, extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ tripId, ...extra }) };
}

const tripBody = {
  departureDate: '2027-03-01',
  returnDate: '2027-03-07',
  paymentDeadline: '2027-02-01',
  totalCapacity: 20,
  preSoldSeats: 0,
  holdTtlHours: 72,
  minimumDepositCents: 100000,
  marginMode: 'PERCENTAGE',
  marginValue: 2000,
  translations: [
    { locale: 'es', name: 'Copper Canyon', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
  ],
};

// Real magic bytes, no valid image data after them: enough for the route's
// signature sniff, which is all the code claims to check.
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

async function createTrip(token: string) {
  const response = await createTripRoute(
    new Request('http://localhost/api/v1/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(tripBody),
    })
  );
  return response.json();
}

function uploadRequest(tripId: string, token: string | undefined, form: FormData) {
  return new Request(`http://localhost/api/v1/trips/${tripId}/images`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

function pngForm(filename = 'cover.png'): FormData {
  const form = new FormData();
  form.set('file', new File([PNG_BYTES], filename, { type: 'image/png' }));
  return form;
}

describe('image endpoints', () => {
  let storageRoot: string;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
    // A throwaway directory per test rather than the developer's own
    // `STORAGE_LOCAL_ROOT`: this suite writes and deletes real files, and
    // must never touch a location outside its own control.
    storageRoot = mkdtempSync(join(tmpdir(), 'rm-images-test-'));
    setStorage(new LocalFileStorage(storageRoot, 'http://localhost/api/v1/files'));
  });

  afterEach(() => {
    setStorage(undefined);
    rmSync(storageRoot, { recursive: true, force: true });
  });

  afterAll(() => closeTestDb());

  describe('POST /api/v1/trips/:tripId/images', () => {
    it('succeeds for an actor holding trip.update and makes the first image the cover', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const response = await uploadImageRoute(uploadRequest(created.id, token, pngForm()), withParams(created.id));

      expect(response.status).toBe(201);
      const image = await response.json();
      expect(image.isCover).toBe(true);
      expect(image.position).toBe(0);
      // The stored key is derived from the trip id and a generated id, never
      // from the client's filename.
      expect(image.storageKey).toMatch(new RegExp(`^trips/${created.id}/[0-9a-f-]+\\.png$`));
      expect(await storage().exists(image.storageKey)).toBe(true);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view']);

      const response = await uploadImageRoute(uploadRequest(created.id, token, pngForm()), withParams(created.id));
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await uploadImageRoute(uploadRequest('any-id', undefined, pngForm()), withParams('any-id'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('returns NOT_FOUND for a trip that does not exist', async () => {
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);
      const missingTripId = randomUUID();
      const response = await uploadImageRoute(uploadRequest(missingTripId, token, pngForm()), withParams(missingTripId));
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    });

    it('makes the second uploaded image not the cover', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      await uploadImageRoute(uploadRequest(created.id, token, pngForm('first.png')), withParams(created.id));
      const second = await (
        await uploadImageRoute(uploadRequest(created.id, token, pngForm('second.png')), withParams(created.id))
      ).json();

      expect(second.isCover).toBe(false);
      expect(second.position).toBe(1);
    });

    it('rejects a request with no file part at all', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const form = new FormData();
      form.set('altText', 'no file here');
      const response = await uploadImageRoute(uploadRequest(created.id, token, form), withParams(created.id));

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.field).toBe('file');
    });

    it('rejects a zero-byte file', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const form = new FormData();
      form.set('file', new File([], 'empty.png', { type: 'image/png' }));
      const response = await uploadImageRoute(uploadRequest(created.id, token, form), withParams(created.id));

      expect(response.status).toBe(422);
      expect((await response.json()).details.field).toBe('file');
    });

    it('rejects a file whose declared content type does not match its actual bytes', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const form = new FormData();
      // Declares image/png, but the bytes are plain text -- a spoofed MIME
      // type, exactly the case the signature sniff exists to catch.
      form.set('file', new File(['<script>alert(1)</script>'], 'cover.png', { type: 'image/png' }));
      const response = await uploadImageRoute(uploadRequest(created.id, token, form), withParams(created.id));

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.field).toBe('contentType');
    });

    it('rejects a file over the size limit', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
      const form = new FormData();
      form.set('file', new File([oversized], 'huge.png', { type: 'image/png' }));
      const response = await uploadImageRoute(uploadRequest(created.id, token, form), withParams(created.id));

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.field).toBe('size');
    });

    it('rejects a malformed multipart body instead of crashing', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const response = await uploadImageRoute(
        new Request(`http://localhost/api/v1/trips/${created.id}/images`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data' },
          body: 'not-actually-multipart',
        }),
        withParams(created.id)
      );

      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it('ignores a filename containing path traversal characters when deriving the storage key', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);

      const response = await uploadImageRoute(
        uploadRequest(created.id, token, pngForm('../../../../etc/passwd.png')),
        withParams(created.id)
      );

      expect(response.status).toBe(201);
      const image = await response.json();
      expect(image.storageKey).not.toContain('..');
      expect(image.storageKey).not.toContain('etc/passwd');
      expect(image.storageKey.startsWith(`trips/${created.id}/`)).toBe(true);
    });
  });

  describe('DELETE /api/v1/trips/:tripId/images/:imageId', () => {
    async function uploadTwo(token: string, tripId: string) {
      const first = await (
        await uploadImageRoute(uploadRequest(tripId, token, pngForm('first.png')), withParams(tripId))
      ).json();
      const second = await (
        await uploadImageRoute(uploadRequest(tripId, token, pngForm('second.png')), withParams(tripId))
      ).json();
      return { first, second };
    }

    it('succeeds for an actor holding trip.update', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);
      const { first } = await uploadTwo(token, created.id);

      const response = await deleteImageRoute(
        new Request(`http://localhost/api/v1/trips/${created.id}/images/${first.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withParams(created.id, { imageId: first.id })
      );
      expect(response.status).toBe(200);
    });

    it('returns 403 PERMISSION_DENIED for an actor holding only trip.view', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const editor = await loginAs(db, 'editor@agency.test', ['trip.update']);
      const { first } = await uploadTwo(editor, created.id);
      const token = await loginAs(db, 'viewer@agency.test', ['trip.view']);

      const response = await deleteImageRoute(
        new Request(`http://localhost/api/v1/trips/${created.id}/images/${first.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withParams(created.id, { imageId: first.id })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 TOKEN_INVALID for an unauthenticated caller', async () => {
      const response = await deleteImageRoute(
        new Request('http://localhost/api/v1/trips/any-id/images/any-image', { method: 'DELETE' }),
        withParams('any-id', { imageId: 'any-image' })
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('returns NOT_FOUND for an image that does not exist', async () => {
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);
      const missingTripId = randomUUID();
      const missingImageId = randomUUID();
      const response = await deleteImageRoute(
        new Request(`http://localhost/api/v1/trips/${missingTripId}/images/${missingImageId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withParams(missingTripId, { imageId: missingImageId })
      );
      expect(response.status).toBe(404);
    });

    it('promotes the next image to cover when the cover is deleted, and removes the stored object', async () => {
      const creator = await loginAs(db, 'creator@agency.test', ['trip.create']);
      const created = await createTrip(creator);
      const token = await loginAs(db, 'editor@agency.test', ['trip.update']);
      const { first, second } = await uploadTwo(token, created.id);
      expect(first.isCover).toBe(true);
      expect(second.isCover).toBe(false);

      await deleteImageRoute(
        new Request(`http://localhost/api/v1/trips/${created.id}/images/${first.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        withParams(created.id, { imageId: first.id })
      );

      const promoted = await db.tripImage.findUniqueOrThrow({ where: { id: second.id } });
      expect(promoted.isCover).toBe(true);

      // The stored object was deleted, not just the database row.
      expect(await storage().exists(first.storageKey)).toBe(false);
      await expect(db.tripImage.findUniqueOrThrow({ where: { id: first.id } })).rejects.toThrow();
    });
  });
});
