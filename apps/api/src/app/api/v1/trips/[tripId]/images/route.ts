import { fail } from '@rm/shared-utils';
import { addTripImage } from '@rm/domain-trips';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { storage } from '../../../../../../lib/storage';

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The three formats the trip gallery accepts, keyed by their magic bytes
 * rather than by whatever content type the browser attached to the
 * multipart part.
 *
 * A browser's `File.type` is whatever the OS or the browser guessed from the
 * filename extension, and nothing stops a client from sending an arbitrary
 * byte stream (an HTML document with a `<script>` tag, say) labelled
 * `image/png`. Trusting that label would let such a file land in storage and
 * later be served back by `GET /api/v1/files/[...key]` -- this endpoint is
 * the first one in the API to accept a file at all, so this is the one place
 * that check has to happen. Sniffing the actual bytes and deriving both the
 * stored content type and the file extension from the sniff result (never
 * from the client) closes that gap: a mislabelled non-image is rejected
 * before it ever reaches the storage provider.
 *
 * This sniff, the multipart parsing and the size limit below are the
 * transport-level parts of accepting an upload -- facts about what arrived
 * over the wire. The business rules about the trip's gallery (first image
 * becomes the cover, position sequencing) live in `@rm/domain-trips`'s
 * `addTripImage`, which this handler calls once the upload has been
 * validated.
 */
const IMAGE_SIGNATURES: { type: 'image/jpeg' | 'image/png' | 'image/webp'; extension: string; matches: (buffer: Buffer) => boolean }[] = [
  {
    type: 'image/jpeg',
    extension: 'jpg',
    matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    type: 'image/png',
    extension: 'png',
    matches: (buffer) =>
      buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    extension: 'webp',
    matches: (buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function sniffImageType(buffer: Buffer): { type: string; extension: string } | undefined {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(buffer));
}

export const POST = route({
  permission: 'trip.update',
  successStatus: 201,
  handler: async ({ params, request }) => {
    // `request.formData()` throws for a body that is not well-formed
    // multipart at all (wrong content-type, a missing boundary, a truncated
    // body) rather than returning something we can branch on. `route()`
    // wraps every handler in a try/catch that would otherwise turn this into
    // a generic 500 for what is really a client mistake, so it is caught
    // here and reported the same way a missing `file` field is.
    const form = await request.formData().catch(() => undefined);
    if (!form) return fail('VALIDATION_FAILED', { field: 'file' });

    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return fail('VALIDATION_FAILED', { field: 'file' });
    if (file.size > MAX_BYTES) return fail('VALIDATION_FAILED', { field: 'size', maxBytes: MAX_BYTES });

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffImageType(buffer);
    if (!sniffed) return fail('VALIDATION_FAILED', { field: 'contentType' });

    const altText = form.get('altText');
    return addTripImage(db(), storage(), params['tripId'], {
      buffer,
      contentType: sniffed.type,
      extension: sniffed.extension,
      altText: typeof altText === 'string' ? altText : undefined,
    });
  },
});
