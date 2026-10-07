import { getPublishedTripBySlug } from '@rm/domain-trips';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { withImageUrlsResult } from '../../../../../../lib/http/trip-response';

/**
 * The public trip catalogue's detail page, by slug. No authentication, no
 * permission check. `getPublishedTripBySlug` answers `NOT_FOUND` (never an
 * empty detail) both for a slug that does not exist and for one that
 * exists but is not `PUBLISHED` -- see its own doc comment and
 * `docs/business-rules/trips.md`, "El catálogo público".
 */
export const GET = route({
  auth: 'public',
  handler: async ({ params }) => withImageUrlsResult(await getPublishedTripBySlug(db(), params['slug'] as string)),
});
