import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { StorageProvider } from '@rm/storage';
import { addTripImage, deleteTripImage } from './trip-image-service';

const db = withTestDb();

/**
 * Minimal in-memory `StorageProvider` double. This suite exercises the
 * business rules around the trip gallery (cover assignment, position
 * sequencing, cover promotion) -- the storage backend itself already has its
 * own contract tests in `@rm/storage`, so a real filesystem or S3 round trip
 * would only slow this suite down without covering anything new.
 */
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

function imageInput(byte: string) {
  return { buffer: Buffer.from(byte), contentType: 'image/png', extension: 'png' };
}

let tripId: string;

describe('trip image service', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(async () => {
    await resetDatabase(db);
    const creator = await db.user.create({ data: { email: 'c@agency.test', type: 'STAFF' } });
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2026',
        departureDate: new Date('2026-12-01'),
        returnDate: new Date('2026-12-07'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100_000,
        marginMode: 'PERCENTAGE',
        marginValue: 2000,
        createdById: creator.id,
      },
    });
    tripId = trip.id;
  });
  afterAll(() => closeTestDb());

  describe('addTripImage', () => {
    it('makes the first uploaded image the cover, at position 0', async () => {
      const storage = fakeStorage();
      const result = await addTripImage(db, storage, tripId, imageInput('a'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCover).toBe(true);
        expect(result.value.position).toBe(0);
        expect(result.value.url).toBe(`http://localhost/api/v1/files/${result.value.storageKey}`);
      }
    });

    it('sequences positions in upload order and does not make a later image the cover', async () => {
      const storage = fakeStorage();
      await addTripImage(db, storage, tripId, imageInput('a'));
      const second = await addTripImage(db, storage, tripId, imageInput('b'));

      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.isCover).toBe(false);
        expect(second.value.position).toBe(1);
      }
    });

    it('returns NOT_FOUND for a trip that does not exist', async () => {
      const storage = fakeStorage();
      const result = await addTripImage(db, storage, randomUUID(), imageInput('a'));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
      // Nothing was written to storage for a trip that does not exist.
      expect(storage.objects.size).toBe(0);
    });
  });

  describe('deleteTripImage', () => {
    async function uploadTwo(storage: StorageProvider) {
      const first = await addTripImage(db, storage, tripId, imageInput('a'));
      const second = await addTripImage(db, storage, tripId, imageInput('b'));
      if (!first.ok || !second.ok) throw new Error('setup failed');
      return { first: first.value, second: second.value };
    }

    it('promotes the next image to cover when the cover is deleted', async () => {
      const storage = fakeStorage();
      const { first, second } = await uploadTwo(storage);

      const result = await deleteTripImage(db, storage, first.id);
      expect(result.ok).toBe(true);

      const promoted = await db.tripImage.findUniqueOrThrow({ where: { id: second.id } });
      expect(promoted.isCover).toBe(true);
    });

    it('deletes the stored object', async () => {
      const storage = fakeStorage();
      const { first } = await uploadTwo(storage);
      expect(storage.objects.has(first.storageKey)).toBe(true);

      await deleteTripImage(db, storage, first.id);

      expect(storage.objects.has(first.storageKey)).toBe(false);
      await expect(db.tripImage.findUniqueOrThrow({ where: { id: first.id } })).rejects.toThrow();
    });

    it('does not promote anything when the deleted image was not the cover', async () => {
      const storage = fakeStorage();
      const { first, second } = await uploadTwo(storage);

      await deleteTripImage(db, storage, second.id);

      const stillCover = await db.tripImage.findUniqueOrThrow({ where: { id: first.id } });
      expect(stillCover.isCover).toBe(true);
    });

    it('returns NOT_FOUND for an image that does not exist', async () => {
      const storage = fakeStorage();
      const result = await deleteTripImage(db, storage, randomUUID());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    });
  });
});
