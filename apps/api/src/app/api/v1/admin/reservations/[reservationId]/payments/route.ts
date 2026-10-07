import { registerCashPaymentRequestSchema, type RegisterCashPaymentRequest } from '@rm/contracts';
import { listPaymentsForReservation, registerCashPayment } from '@rm/domain-payments';
import { reviveReservationSeat } from '@rm/domain-reservations';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { queue } from '../../../../../../../lib/queue';

/**
 * One reservation's payment history, for the panel's detail screen (Task 19).
 * Gated on `payment.view` -- not `reservation.view` -- because the catalogue
 * already separates who sees money from who sees reservations; the detail
 * screen only asks for this when the viewer holds it.
 */
export const GET = route({
  permission: 'payment.view',
  handler: async ({ params }) => listPaymentsForReservation(db(), params['reservationId'] as string),
});

/**
 * Cash at the counter (Phase 2B, §5.3), with its receipt. A hold that already
 * ran out is revived if a seat is left (decision 13): the seat half is
 * injected here, so the two domains never import each other.
 */
export const POST = route<RegisterCashPaymentRequest, unknown>({
  permission: 'payment.register',
  body: registerCashPaymentRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    registerCashPayment(db(), await queue(), {
      reservationId: params['reservationId'] as string,
      amountCents: body.amountCents,
      actorId: actor.userId,
    }, reviveReservationSeat),
});
