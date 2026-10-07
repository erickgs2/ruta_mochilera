import { listPublishedTrips } from '@rm/domain-trips';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { withImageUrls } from '../../../../../lib/http/trip-response';

/**
 * The public trip catalogue's list page: no authentication, no permission
 * check -- `auth: 'public'` is the entire access rule. See
 * `docs/business-rules/trips.md`, "El catálogo público", for what this
 * deliberately does and does not expose. `withImageUrls` is the same
 * HTTP-boundary helper the staff-facing `/trips` list uses for its own
 * gallery photos (`../../../trips/route.ts`); it works on any
 * `{ images: { storageKey }[] }` shape, public or not, so there is nothing
 * trip-catalogue-specific about reusing it here.
 */
export const GET = route({
  auth: 'public',
  handler: async () => {
    const result = await listPublishedTrips(db());
    if (!result.ok) return result;
    return ok(result.value.map(withImageUrls));
  },
});
