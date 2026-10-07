import { backfillPaymentsRequestSchema, type BackfillPaymentsRequest } from '@rm/contracts';
import { recordBackfilledPayments } from '@rm/domain-payments';
import { backfillMoments } from '../../../../../../lib/backfill-dates';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/** Historical payments for a reservation already in the system: all or none (Phase 2B, §5.7). */
export const POST = route<BackfillPaymentsRequest, unknown>({
  permission: 'data.backfill',
  body: backfillPaymentsRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) => {
    const moments = await backfillMoments(body.payments.map((payment, index) => ({ field: `payments.${index}.paidAt`, date: payment.paidAt })));
    if (!moments.ok) return moments;
    return recordBackfilledPayments(db(), await queue(), {
      reservationId: body.reservationId,
      actorId: actor.userId,
      payments: body.payments.map((payment, index) => ({ ...payment, paidAt: moments.value[index] as Date })),
      sendReceipts: body.sendReceipts,
    });
  },
});
