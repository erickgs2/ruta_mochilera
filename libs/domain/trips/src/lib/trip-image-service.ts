import { randomUUID } from 'node:crypto';
import type { Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { StorageProvider } from '@rm/storage';

export interface TripImageDto {
  id: string;
  tripId: string;
  storageKey: string;
  position: number;
  isCover: boolean;
  altText: string | null;
  url: string;
}

export interface AddTripImageInput {
  buffer: Buffer;
  contentType: string;
  extension: string;
  altText?: string;
}

/**
 * Uploads a file to storage and attaches it to a trip's gallery.
 *
 * Three business rules live here rather than in the HTTP handler, so a CLI
 * or an import path that calls this directly gets them too -- the same
 * reasoning that moved capacity repricing into `updateTrip` (see
 * `trip-service.ts`):
 *
 *  1. The first image ever uploaded for a trip becomes its cover.
 *  2. Images are positioned in upload order, starting at 0.
 *  3. (See `deleteTripImage` below.) Deleting the cover promotes the next one.
 *
 * `storage` is injected as the `StorageProvider` port (`@rm/storage`'s
 * interface, not either concrete implementation) rather than resolved here:
 * that keeps the dependency pointing from this domain to an abstraction,
 * matches how `db` is already injected, and lets a future caller supply its
 * own provider instead of always talking to whatever `apps/api` configured.
 *
 * Deliberately does NOT parse a multipart body, sniff magic bytes, or
 * enforce a size limit: those are transport-level facts about what arrived
 * over the wire, not rules about the trip's gallery, and stay in the HTTP
 * handler (`apps/api/.../images/route.ts`). By the time this function runs,
 * `input.buffer` has already been verified to be one of the accepted image
 * formats and `input.contentType`/`input.extension` were derived from that
 * verification, not from anything the client claimed.
 */
export async function addTripImage(
  db: Db,
  storage: StorageProvider,
  tripId: string,
  input: AddTripImageInput
): Promise<Result<TripImageDto>> {
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
  if (!trip) return fail('NOT_FOUND');

  // The key is derived from the trip id and a freshly generated UUID --
  // never from a client-supplied filename -- so a filename such as
  // `../../etc/passwd.jpg`, or one with no extension at all, never reaches
  // the storage layer as a path component. `assertSafeKey` inside the
  // storage provider (`@rm/storage`) is a second, independent gate on top of
  // this: even if this construction were ever wrong, it would still refuse
  // to write outside its root.
  const key = `trips/${tripId}/${randomUUID()}.${input.extension}`;
  await storage.put(key, input.buffer, input.contentType);

  const count = await db.tripImage.count({ where: { tripId } });
  const image = await db.tripImage.create({
    data: {
      tripId,
      storageKey: key,
      position: count,
      // The first image uploaded becomes the cover by default.
      isCover: count === 0,
      altText: input.altText,
    },
  });

  return ok({ ...image, url: storage.publicUrl(key) });
}

/**
 * Removes an image from a trip's gallery, promoting the next one to cover
 * when the deleted image was the cover.
 *
 * The database row is deleted (and the next image promoted, in the same
 * transaction) before the stored object is touched.
 *
 * The alternative order -- delete the object first, then the row -- fails
 * worse: if the transaction then rolled back for any reason (a
 * serialization conflict, a constraint violation), the row would still
 * point at an object that no longer exists, and every viewer of the trip
 * would see a broken image indefinitely, with nothing to signal that
 * anything is wrong.
 *
 * Doing it this way instead means the only failure mode is an orphaned
 * object in storage -- bytes nobody references any more -- if the
 * provider's `delete` call below fails after the transaction has already
 * committed. That is a wasted-space problem a periodic cleanup job can fix
 * later; it is never a broken reference a customer can see.
 */
export async function deleteTripImage(db: Db, storage: StorageProvider, imageId: string): Promise<Result<null>> {
  const image = await db.tripImage.findUnique({ where: { id: imageId } });
  if (!image) return fail('NOT_FOUND');

  await db.$transaction(async (tx) => {
    await tx.tripImage.delete({ where: { id: image.id } });
    // If the deleted image was the cover, the next one in position order
    // takes its place.
    if (image.isCover) {
      const next = await tx.tripImage.findFirst({
        where: { tripId: image.tripId },
        orderBy: { position: 'asc' },
      });
      if (next) await tx.tripImage.update({ where: { id: next.id }, data: { isCover: true } });
    }
  });

  await storage.delete(image.storageKey);
  return ok(null);
}
