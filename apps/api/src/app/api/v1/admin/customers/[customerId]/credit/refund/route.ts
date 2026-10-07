import { refundCreditRequestSchema, type RefundCreditRequest } from '@rm/contracts';
import { refundCredit } from '@rm/domain-payments';
import { db } from '../../../../../../../../lib/db';
import { route } from '../../../../../../../../lib/http/route';

/**
 * Records that credit was given back to the customer outside the system
 * (cash, a transfer). Never moves money itself; the reason is mandatory.
 */
export const POST = route<RefundCreditRequest, unknown>({
  permission: 'payment.credit.apply',
  body: refundCreditRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    refundCredit(db(), {
      customerId: params['customerId'] as string,
      amountCents: body.amountCents,
      reason: body.reason,
      actorId: actor.userId,
    }),
});
