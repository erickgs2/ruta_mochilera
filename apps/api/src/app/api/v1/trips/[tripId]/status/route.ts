import { changeStatusRequestSchema, type ChangeStatusRequest } from '@rm/contracts';
import { changeTripStatus } from '@rm/domain-trips';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

export const PUT = route<ChangeStatusRequest, unknown>({
  permission: 'trip.publish',
  body: changeStatusRequestSchema,
  handler: async ({ actor, body, params }) =>
    changeTripStatus(db(), actor, params['tripId'], body.status),
});
