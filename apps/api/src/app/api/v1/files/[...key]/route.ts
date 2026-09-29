import { config } from '../../../../../lib/config';
import { storage } from '../../../../../lib/storage';

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
  if (config().storageDriver !== 'local') return new Response(null, { status: 404 });

  const { key } = await context.params;
  try {
    const body = await storage().get(key.join('/'));
    return new Response(new Uint8Array(body), {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
