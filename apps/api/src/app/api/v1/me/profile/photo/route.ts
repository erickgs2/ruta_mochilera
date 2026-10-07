import { setCustomerPhoto } from '@rm/domain-identity';
import { db } from '../../../../../../lib/db';
import { readImageUpload } from '../../../../../../lib/http/image-upload';
import { route } from '../../../../../../lib/http/route';
import { storage } from '../../../../../../lib/storage';

/**
 * Replaces the caller's profile photo. The upload goes through the same
 * `readImageUpload` as the trip gallery (type sniffed from the bytes, same
 * size limit), and the caller is the only possible owner: there is no id in
 * the path.
 */
export const POST = route({
  handler: async ({ actor, request }) => {
    const upload = await readImageUpload(request);
    if (!upload.ok) return upload;
    const { buffer, contentType, extension } = upload.value;
    return setCustomerPhoto(db(), storage(), actor.userId, { buffer, contentType, extension });
  },
});
