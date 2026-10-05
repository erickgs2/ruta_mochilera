import { getReservationForCustomer } from '@rm/domain-reservations';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/**
 * One of the authenticated customer's own reservations. Ownership lives in
 * `getReservationForCustomer` (`@rm/domain-reservations`), not here: a
 * reservation that does not exist and one that belongs to someone else
 * answer the identical `RESERVATION_NOT_OWNED` (404, never 403 -- see
 * `apps/api/src/lib/http/problem.ts`), so this handler stays exactly as
 * thin as every other one in this file -- authenticate, call the domain.
 */
export const GET = route({
  handler: async ({ actor, params }) =>
    getReservationForCustomer(db(), params['reservationId'] as string, actor.userId),
});
