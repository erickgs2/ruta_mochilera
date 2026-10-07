import { adjustCreditRequestSchema, type AdjustCreditRequest } from '@rm/contracts';
import { adjustCredit } from '@rm/domain-payments';
import { db } from '../../../../../../../../lib/db';
import { route } from '../../../../../../../../lib/http/route';

/** A correction or courtesy to a customer's credit, in either direction, with a reason. */
export const POST = route<AdjustCreditRequest, unknown>({
  permission: 'payment.credit.apply',
  body: adjustCreditRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    adjustCredit(db(), {
      customerId: params['customerId'] as string,
      amountCents: body.amountCents,
      reason: body.reason,
      actorId: actor.userId,
    }),
});
