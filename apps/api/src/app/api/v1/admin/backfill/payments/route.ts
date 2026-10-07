import { backfillPaymentsRequestSchema, type BackfillPaymentsRequest } from '@rm/contracts';
import { recordBackfilledPayments } from '@rm/domain-payments';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/**
 * Historical payments for a reservation already in the system: all or none
 * (Phase 2B, §5.7). The calendar days go to the domain as they came; dating
 * them (noon in the organization's zone, never in the future) is its rule.
 */
export const POST = route<BackfillPaymentsRequest, unknown>({
  permission: 'data.backfill',
  body: backfillPaymentsRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    recordBackfilledPayments(db(), await queue(), {
      reservationId: body.reservationId,
      actorId: actor.userId,
      payments: body.payments,
      sendReceipts: body.sendReceipts,
    }),
});
