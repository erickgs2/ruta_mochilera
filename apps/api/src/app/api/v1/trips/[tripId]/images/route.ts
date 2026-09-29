import { randomUUID } from 'node:crypto';
import { fail, ok } from '@rm/shared-utils';
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
    const tripId = params['tripId'];
    if (!(await db().trip.findUnique({ where: { id: tripId }, select: { id: true } }))) {
      return fail('NOT_FOUND');
    }

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

    // The key is derived from the trip id and a freshly generated UUID --
    // never from the client-supplied filename -- so a filename such as
    // `../../etc/passwd.jpg`, or one with no extension at all, never reaches
    // the storage layer as a path component. `assertSafeKey` inside the
    // storage provider (`@rm/storage`) is a second, independent gate on top
    // of this: even if this construction were ever wrong, it would still
    // refuse to write outside its root.
    const key = `trips/${tripId}/${randomUUID()}.${sniffed.extension}`;
    await storage().put(key, buffer, sniffed.type);

    const count = await db().tripImage.count({ where: { tripId } });
    const image = await db().tripImage.create({
      data: {
        tripId,
        storageKey: key,
        position: count,
        // The first image uploaded becomes the cover by default.
        isCover: count === 0,
        altText: (form.get('altText') as string | null) ?? undefined,
      },
    });

    return ok({ ...image, url: storage().publicUrl(key) });
  },
});
