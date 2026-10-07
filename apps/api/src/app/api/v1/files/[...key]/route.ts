import { config } from '../../../../../lib/config';
import { storage } from '../../../../../lib/storage';

/**
 * Prefixes that hold private documents and are only ever served through an
 * authenticated route that checks ownership or a permission -- payment
 * receipts (Phase 2B) go through `/payments/{id}/receipt`. This public
 * passthrough answers them with the same bare 404 as a missing key.
 */
const PRIVATE_PREFIXES = new Set(['receipts']);

/**
 * Serves locally stored files in development. In qa and production the
 * driver is S3 and files are served straight from the bucket, so this route
 * refuses -- it is not a general-purpose passthrough, only the local
 * driver's counterpart to a bucket's own public URL.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  if (config().storageDriver !== 'local') {
    // The response is a bare 404, same as a genuine missing key -- the
    // client must never learn how storage is configured. But a 404 here
    // could otherwise mean either "this file does not exist" or "this route
    // is being hit in an environment where it should never be reachable at
    // all", and those need different fixes. Logging server-side, naming the
    // driver, is what makes that second case discoverable instead of
    // looking exactly like the first one forever.
    console.warn(`Refusing to serve a local file: storage driver is "${config().storageDriver}", not "local"`);
    return new Response(null, { status: 404 });
  }

  const { key } = await context.params;
  // Case-insensitive: on a case-insensitive filesystem `Receipts/...` is the same file.
  if (PRIVATE_PREFIXES.has((key[0] ?? '').toLowerCase())) return new Response(null, { status: 404 });
  try {
    const body = await storage().get(key.join('/'));
    return new Response(new Uint8Array(body), {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
