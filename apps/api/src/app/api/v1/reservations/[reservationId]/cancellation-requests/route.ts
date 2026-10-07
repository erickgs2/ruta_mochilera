import { requestCancellationRequestSchema, type RequestCancellationRequest } from '@rm/contracts';
import { requestCancellation } from '@rm/domain-reservations';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/**
 * Records that the customer asked for their own reservation to be
 * cancelled (§5.6). `requestCancellation` deliberately does **not** change
 * `status` -- it only seals `cancellation_requested_at` and notifies staff
 * (via `queue`, the same pg-boss-backed singleton the Stripe webhook
 * enqueues through), who decide from the panel. Ownership is the same
 * `RESERVATION_NOT_OWNED` check `getReservationForCustomer` uses, enforced
 * inside the domain.
 */
export const POST = route<RequestCancellationRequest, unknown>({
  body: requestCancellationRequestSchema,
  handler: async ({ actor, body, params }) =>
    requestCancellation(db(), params['reservationId'] as string, actor.userId, await queue(), body.reason),
});
