import { markRead } from '@rm/domain-notifications';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/**
 * Marks one of the authenticated customer's own INBOX deliveries as read.
 * `markRead` (`@rm/domain-notifications`) answers the identical
 * `DELIVERY_NOT_OWNED` (404, never 403) for a delivery that does not exist
 * and one that belongs to someone else -- the same reasoning
 * `RESERVATION_NOT_OWNED` uses one domain over. No response body: there is
 * nothing to return beyond "done".
 */
export const POST = route({
  successStatus: 204,
  handler: async ({ actor, params }) => markRead(db(), params['deliveryId'] as string, actor.userId),
});
