import { backfillReservationRequestSchema, type BackfillReservationRequest } from '@rm/contracts';
import { createBackfilledPaymentsHook } from '@rm/domain-payments';
import { createBackfilledReservation } from '@rm/domain-reservations';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/**
 * Captures a reservation that happened before the system, with its payments
 * (Phase 2B, §5.7). Receipts stay silent unless `sendReceipts`. The calendar
 * days go to the domain as they came; dating them (noon in the organization's
 * zone, never in the future) is its rule.
 */
export const POST = route<BackfillReservationRequest, unknown>({
  permission: 'data.backfill',
  body: backfillReservationRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    createBackfilledReservation(db(), {
      tripId: body.tripId,
      customerId: body.customerId,
      actorId: actor.userId,
      createdAt: body.createdAt,
      totalPriceCents: body.totalPriceCents,
      recordPayments:
        body.payments.length > 0
          ? createBackfilledPaymentsHook(await queue(), body.payments, body.sendReceipts)
          : undefined,
    }),
});
