import { createPaymentIntentRequestSchema, type CreatePaymentIntentRequest } from '@rm/contracts';
import { createPaymentIntentForReservation } from '@rm/domain-payments';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { paymentProvider } from '../../../../../../lib/payment-provider';

/**
 * The entry point of the whole payment flow (spec §9): asks the configured
 * `PaymentProvider` (Stripe, or `FakePaymentProvider` when no Stripe keys
 * are configured -- see `apps/api/src/lib/payment-provider.ts`) for a
 * Payment Intent against one of the caller's own reservations, and writes
 * the matching `PENDING` `Payment` row.
 *
 * **No amount travels in the request body.** `createPaymentIntentRequestSchema`
 * (`@rm/contracts`) carries only `intent` (`'FULL'` or `'DEPOSIT'`) and
 * `method` -- `createPaymentIntentForReservation` computes the number of
 * cents from the reservation itself. See that function's own doc comment
 * (`@rm/domain-payments`) for the full rule, including why ownership
 * (`RESERVATION_NOT_OWNED`, 404) and the terminal-status refusal
 * (`INVALID_STATUS_TRANSITION`) both live in the domain rather than here.
 */
export const POST = route<CreatePaymentIntentRequest, unknown>({
  body: createPaymentIntentRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) =>
    createPaymentIntentForReservation(db(), paymentProvider(), {
      reservationId: params['reservationId'] as string,
      customerId: actor.userId,
      intent: body.intent,
      method: body.method,
    }),
});
