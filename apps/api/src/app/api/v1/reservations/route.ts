import { createReservationRequestSchema, type CreateReservationRequest } from '@rm/contracts';
import { createReservation, listReservationsForCustomer } from '@rm/domain-reservations';
import { db } from '../../../../lib/db';
import { withSuggestedMonthly } from '../../../../lib/http/reservation-response';
import { route } from '../../../../lib/http/route';

/**
 * The customer's own reservations. No `permission`/`anyPermission`:
 * these endpoints are not governed by the RBAC catalogue at all (that
 * governs staff) -- the only check is ownership, enforced inside
 * `@rm/domain-reservations` itself (`listReservationsForCustomer` scopes by
 * `customerId`, so a `STAFF` actor -- who never owns a reservation --
 * simply sees an empty list rather than needing a separate actor-type
 * branch here).
 */
export const GET = route({
  handler: async ({ actor }) => listReservationsForCustomer(db(), actor.userId),
});

/**
 * Creates a reservation for the authenticated customer on one trip (§5.2).
 * A `STAFF` actor is refused by the domain itself: `createReservation`
 * requires the caller's id to own a `CustomerProfile`, which no staff user
 * has (`NOT_FOUND`) -- this is the same ownership-shaped reasoning as the
 * rest of this resource, not a permission gate.
 *
 * Answers with `suggestedMonthlyCents` too: the reserve screen shows the
 * amounts of the hold it just created -- see `withSuggestedMonthly`.
 */
export const POST = route<CreateReservationRequest, unknown>({
  body: createReservationRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    withSuggestedMonthly(db(), await createReservation(db(), { tripId: body.tripId, customerId: actor.userId })),
});
