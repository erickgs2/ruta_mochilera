import { applyCreditRequestSchema, type ApplyCreditRequest } from '@rm/contracts';
import { applyCreditToReservation } from '@rm/domain-payments';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';

/**
 * Pays part of a live reservation with its customer's credit: a numbered
 * `CREDIT` payment plus the matching `APPLIED` movement, in one transaction.
 */
export const POST = route<ApplyCreditRequest, unknown>({
  permission: 'payment.credit.apply',
  body: applyCreditRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    applyCreditToReservation(db(), {
      reservationId: params['reservationId'] as string,
      amountCents: body.amountCents,
      actorId: actor.userId,
    }),
});
