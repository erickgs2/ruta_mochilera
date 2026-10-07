import { declineCancellationRequestSchema, type DeclineCancellationRequest } from '@rm/contracts';
import { declineCancellationRequest } from '@rm/domain-reservations';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { queue } from '../../../../../../../lib/queue';

/**
 * Staff decide a customer's cancellation request does not go ahead (§5.6):
 * the reservation stays as it is and the request leaves the pending queue.
 * The same single grant as cancelling, `reservation.cancel` -- whoever may
 * decide a request one way may decide it the other.
 */
export const POST = route<DeclineCancellationRequest, unknown>({
  permission: 'reservation.cancel',
  body: declineCancellationRequestSchema,
  handler: async ({ actor, body, params }) =>
    declineCancellationRequest(db(), await queue(), {
      reservationId: params['reservationId'] as string,
      actorId: actor.userId,
      reason: body.reason,
    }),
});
