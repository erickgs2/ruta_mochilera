import { cancelReservationRequestSchema, type CancelReservationRequest } from '@rm/contracts';
import { createCancelPendingPaymentIntents } from '@rm/domain-payments';
import { cancelReservation } from '@rm/domain-reservations';
import { db } from '../../../../../../../lib/db';
import { paymentProvider } from '../../../../../../../lib/payment-provider';
import { route } from '../../../../../../../lib/http/route';
import { queue } from '../../../../../../../lib/queue';

/**
 * A person decides on a reservation (§5.6, Task 19): cancels it, releasing
 * its seat and keeping every cent already paid. `permission`, not
 * `anyPermission`: exactly one grant allows this, `reservation.cancel`.
 *
 * Wires the same `createCancelPendingPaymentIntents` hook `apps/worker`
 * gives `expireHolds`, so an OXXO voucher still outstanding stops being
 * payable once the seat is gone. Idempotent: a second call answers the
 * already-cancelled reservation with 200 and changes nothing.
 */
export const POST = route<CancelReservationRequest, unknown>({
  permission: 'reservation.cancel',
  body: cancelReservationRequestSchema,
  handler: async ({ actor, body, params }) =>
    cancelReservation(
      db(),
      await queue(),
      { reservationId: params['reservationId'] as string, actorId: actor.userId, reason: body.reason },
      createCancelPendingPaymentIntents(paymentProvider())
    ),
});
