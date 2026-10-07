import { applyCreditRequestSchema, type ApplyCreditRequest } from '@rm/contracts';
import { applyCreditToReservation } from '@rm/domain-payments';
import { reviveReservationSeat } from '@rm/domain-reservations';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { queue } from '../../../../../../../lib/queue';

/**
 * Pays part of a live reservation with its customer's credit: a numbered
 * `CREDIT` payment plus the matching `APPLIED` movement, in one transaction.
 * A hold that already ran out is revived if a seat is left (decision 13): the
 * seat half is injected here, so the two domains never import each other.
 */
export const POST = route<ApplyCreditRequest, unknown>({
  permission: 'payment.credit.apply',
  body: applyCreditRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    applyCreditToReservation(db(), await queue(), {
      reservationId: params['reservationId'] as string,
      amountCents: body.amountCents,
      actorId: actor.userId,
    }, reviveReservationSeat),
});
