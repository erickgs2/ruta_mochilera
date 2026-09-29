import { fail, ok } from '@rm/shared-utils';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { storage } from '../../../../../../../lib/storage';

export const DELETE = route({
  permission: 'trip.update',
  handler: async ({ params }) => {
    const image = await db().tripImage.findUnique({ where: { id: params['imageId'] } });
    if (!image) return fail('NOT_FOUND');

    // The database row is deleted (and the next image promoted to cover, in
    // the same transaction) before the stored object is touched.
    //
    // The alternative order -- delete the object first, then the row --
    // fails worse: if the transaction then rolled back for any reason (a
    // serialization conflict, a constraint violation), the row would still
    // point at an object that no longer exists, and every viewer of the trip
    // would see a broken image indefinitely, with nothing to signal that
    // anything is wrong.
    //
    // Doing it this way instead means the only failure mode is an orphaned
    // object in storage -- bytes nobody references any more -- if the
    // provider's `delete` call below fails after the transaction has already
    // committed. That is a wasted-space problem a periodic cleanup job can
    // fix later; it is never a broken reference a customer can see.
    await db().$transaction(async (tx) => {
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

    await storage().delete(image.storageKey);
    return ok(null);
  },
});
