import { updateTripRequestSchema, type UpdateTripRequest } from '@rm/contracts';
import { getTrip, updateTrip } from '@rm/domain-trips';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { withImageUrlsResult } from '../../../../../lib/http/trip-response';

export const GET = route({
  permission: 'trip.view',
  handler: async ({ params }) => withImageUrlsResult(await getTrip(db(), params['tripId'])),
});

export const PUT = route<UpdateTripRequest, unknown>({
  permission: 'trip.update',
  body: updateTripRequestSchema,
  handler: async ({ actor, body, params }) =>
    withImageUrlsResult(await updateTrip(db(), actor, params['tripId'], body)),
});
