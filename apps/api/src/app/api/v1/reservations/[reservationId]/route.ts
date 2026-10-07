import { getReservationForCustomer } from '@rm/domain-reservations';
import { db } from '../../../../../lib/db';
import { withSuggestedMonthly } from '../../../../../lib/http/reservation-response';
import { route } from '../../../../../lib/http/route';

/**
 * One of the authenticated customer's own reservations. Ownership lives in
 * `getReservationForCustomer` (`@rm/domain-reservations`), not here: a
 * reservation that does not exist and one that belongs to someone else
 * answer the identical `RESERVATION_NOT_OWNED` (404, never 403 -- see
 * `apps/api/src/lib/http/problem.ts`), so this handler stays exactly as
 * thin as every other one in this file -- authenticate, call the domain.
 * `withSuggestedMonthly` adds the suggested monthly payment on the way out.
 */
export const GET = route({
  handler: async ({ actor, params }) =>
    withSuggestedMonthly(db(), await getReservationForCustomer(db(), params['reservationId'] as string, actor.userId)),
});
