import { createPaymentIntentRequestSchema, type CreatePaymentIntentRequest } from '@rm/contracts';
import { createPaymentIntentForReservation } from '@rm/domain-payments';
import { fail } from '@rm/shared-utils';
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
  handler: async ({ actor, body, params }) => {
    // `AMOUNT` is in the contract (abono libre, task A3) but the domain serves
    // it from task A5; until then it is refused rather than charged as FULL.
    if (body.intent === 'AMOUNT') return fail('VALIDATION_FAILED', { field: 'intent', reason: 'not_supported_yet' });
    return createPaymentIntentForReservation(db(), paymentProvider(), {
      reservationId: params['reservationId'] as string,
      customerId: actor.userId,
      intent: body.intent,
      method: body.method,
    });
  },
});
