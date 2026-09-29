import { deleteTripImage } from '@rm/domain-trips';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { storage } from '../../../../../../../lib/storage';

/**
 * The delete-order rationale (row before object) and the cover-promotion
 * rule live in `@rm/domain-trips`'s `deleteTripImage`, not here -- this
 * handler's only job is authenticating, checking the permission and
 * delegating.
 */
export const DELETE = route({
  permission: 'trip.update',
  handler: async ({ params }) => deleteTripImage(db(), storage(), params['imageId']),
});
