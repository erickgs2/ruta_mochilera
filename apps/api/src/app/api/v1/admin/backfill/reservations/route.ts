import { backfillReservationRequestSchema, type BackfillReservationRequest } from '@rm/contracts';
import { createBackfilledPaymentsHook } from '@rm/domain-payments';
import { createBackfilledReservation } from '@rm/domain-reservations';
import { backfillMoments } from '../../../../../../lib/backfill-dates';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/**
 * Captures a reservation that happened before the system, with its payments
 * (Phase 2B, §5.7). Receipts stay silent unless `sendReceipts`.
 */
export const POST = route<BackfillReservationRequest, unknown>({
  permission: 'data.backfill',
  body: backfillReservationRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) => {
    const moments = await backfillMoments([
      { field: 'createdAt', date: body.createdAt },
      ...body.payments.map((payment, index) => ({ field: `payments.${index}.paidAt`, date: payment.paidAt })),
    ]);
    if (!moments.ok) return moments;
    const [createdAt, ...paidAts] = moments.value as [Date, ...Date[]];
    return createBackfilledReservation(db(), {
      tripId: body.tripId,
      customerId: body.customerId,
      actorId: actor.userId,
      createdAt,
      totalPriceCents: body.totalPriceCents,
      recordPayments:
        body.payments.length > 0
          ? createBackfilledPaymentsHook(
              await queue(),
              body.payments.map((payment, index) => ({ ...payment, paidAt: paidAts[index] as Date })),
              body.sendReceipts
            )
          : undefined,
    });
  },
});
