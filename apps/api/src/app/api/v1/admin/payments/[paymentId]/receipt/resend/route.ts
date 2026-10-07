import { requestReceiptResend } from '@rm/domain-payments';
import { db } from '../../../../../../../../lib/db';
import { route } from '../../../../../../../../lib/http/route';
import { queue } from '../../../../../../../../lib/queue';

/**
 * Staff send a receipt again -- or for the first time, for a payment
 * captured without sending. Queued; the worker does the sending.
 */
export const POST = route({
  permission: 'payment.view',
  successStatus: 202,
  handler: async ({ params }) => requestReceiptResend(db(), await queue(), params['paymentId'] as string),
});
