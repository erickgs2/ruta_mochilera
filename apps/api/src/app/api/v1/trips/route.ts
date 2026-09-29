import { createTripRequestSchema, type CreateTripRequest } from '@rm/contracts';
import { createTrip, listTrips, type TripStatus } from '@rm/domain-trips';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

export const GET = route({
  permission: 'trip.view',
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    return listTrips(db(), {
      status: (params.get('status') as TripStatus | null) ?? undefined,
      search: params.get('search') ?? undefined,
    });
  },
});

export const POST = route<CreateTripRequest, unknown>({
  permission: 'trip.create',
  body: createTripRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) => createTrip(db(), actor, body),
});
