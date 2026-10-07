import { backfillPaymentsRequestSchema, type BackfillPaymentsRequest } from '@rm/contracts';
import { recordBackfilledPayments } from '@rm/domain-payments';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/** Historical payments for a reservation already in the system: all or none (Phase 2B, §5.7). */
export const POST = route<BackfillPaymentsRequest, unknown>({
  permission: 'data.backfill',
  body: backfillPaymentsRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    recordBackfilledPayments(db(), await queue(), {
      reservationId: body.reservationId,
      actorId: actor.userId,
      payments: body.payments.map((payment) => ({ ...payment, paidAt: new Date(payment.paidAt) })),
      sendReceipts: body.sendReceipts,
    }),
});
