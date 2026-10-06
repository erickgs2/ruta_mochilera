import { addTripImage } from '@rm/domain-trips';
import { db } from '../../../../../../lib/db';
import { readImageUpload } from '../../../../../../lib/http/image-upload';
import { route } from '../../../../../../lib/http/route';
import { storage } from '../../../../../../lib/storage';

/**
 * Uploads one trip gallery image. The multipart parsing, the size limit and
 * the magic-byte sniff live in `readImageUpload`, shared with the customer's
 * profile photo; the business rules about the gallery (first image becomes
 * the cover, position sequencing) live in `@rm/domain-trips`'s
 * `addTripImage`, which this handler calls once the upload has been
 * validated.
 */
export const POST = route({
  permission: 'trip.update',
  successStatus: 201,
  handler: async ({ params, request }) => {
    const upload = await readImageUpload(request);
    if (!upload.ok) return upload;

    const altText = upload.value.form.get('altText');
    return addTripImage(db(), storage(), params['tripId'], {
      buffer: upload.value.buffer,
      contentType: upload.value.contentType,
      extension: upload.value.extension,
      altText: typeof altText === 'string' ? altText : undefined,
    });
  },
});
