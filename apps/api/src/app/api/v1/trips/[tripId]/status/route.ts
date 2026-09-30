import { changeStatusRequestSchema, type ChangeStatusRequest } from '@rm/contracts';
import { changeTripStatus } from '@rm/domain-trips';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { withImageUrlsResult } from '../../../../../../lib/http/trip-response';

/**
 * Coarse entry gate: reachable by anyone holding `trip.publish` OR
 * `trip.cancel`. `changeTripStatus` (the domain) makes the precise call --
 * `trip.cancel` specifically for a transition to CANCELLED, `trip.publish`
 * for every other one -- so a `trip.cancel`-only actor genuinely can cancel
 * a trip through this route, not just be authorized on paper. See
 * `docs/business-rules/trips.md`.
 */
export const PUT = route<ChangeStatusRequest, unknown>({
  anyPermission: ['trip.publish', 'trip.cancel'],
  body: changeStatusRequestSchema,
  handler: async ({ actor, body, params }) =>
    withImageUrlsResult(await changeTripStatus(db(), actor, params['tripId'], body.status)),
});
