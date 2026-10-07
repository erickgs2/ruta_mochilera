import { applyPriceChangeRequestSchema, type ApplyPriceChangeRequest } from '@rm/contracts';
import { creditFromPriceDecrease } from '@rm/domain-payments';
import { applyPriceChange, previewPriceChange } from '@rm/domain-reservations';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { queue } from '../../../../../../lib/queue';

/**
 * Bringing the trip's current price to its existing reservations (Phase 2B,
 * §5.6). Under `/trips/{tripId}` next to costing, where the price is edited.
 * GET previews; POST applies with the mandatory notice, wiring
 * `creditFromPriceDecrease` from `@rm/domain-payments` into the change's
 * transaction.
 */
export const GET = route({
  permission: 'trip.change_price',
  handler: async ({ params }) => previewPriceChange(db(), params['tripId'] as string),
});

export const POST = route<ApplyPriceChangeRequest, unknown>({
  permission: 'trip.change_price',
  body: applyPriceChangeRequestSchema,
  handler: async ({ actor, body, params }) =>
    applyPriceChange(
      db(),
      await queue(),
      { tripId: params['tripId'] as string, noticeEs: body.noticeEs, noticeEn: body.noticeEn, actorId: actor.userId },
      creditFromPriceDecrease
    ),
});
