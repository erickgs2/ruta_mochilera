import { handleStripeEvent } from '@rm/domain-payments';
import { fail } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';
import { paymentProvider } from '../../../../../lib/payment-provider';
import { queue } from '../../../../../lib/queue';

/**
 * Stripe's webhook endpoint: the only public route in this system that
 * writes (spec 7).
 *
 * **Why there is no Zod `body` schema, and why that is not a loophole.**
 * `route()`'s `application/json` requirement lives inside `parseBody`, and
 * `parseBody` only runs when a `body` schema is declared (see its doc
 * comment, and `hasJsonContentType`). A route with no schema never reaches
 * that check and never touches `request.json()`, so this handler can read
 * `request.text()` and get the exact bytes Stripe sent -- which is the only
 * thing the signature is computed over. **No exception had to be added to
 * `route()` and none was**: the media-type check applies to every route
 * that declares a body, exactly as before.
 *
 * That check exists to force a CORS preflight on `POST /auth/login`, where
 * a safelisted `text/plain` body would otherwise allow a login CSRF. None
 * of that reasoning transfers here. There is no cookie and no ambient
 * authority on this route: the *only* thing that decides whether it acts is
 * an HMAC over the body computed with `STRIPE_WEBHOOK_SECRET`, which a
 * cross-site page cannot produce. A browser forging this request would
 * merely get a 422.
 *
 * Zod is skipped for the same reason, not out of laziness: the body is not
 * a client-supplied shape to validate, it is signed bytes to verify. Parsing
 * happens afterwards, inside `PaymentProvider.verifyWebhook`, and only once
 * the signature holds.
 *
 * **Everything else is the usual four steps**, minus the two that cannot
 * apply: there is no actor to authenticate (`auth: 'public'`) and therefore
 * no permission to check. The handler verifies, then delegates to
 * `handleStripeEvent`, which owns every database effect and the
 * idempotency ordering.
 *
 * **Status codes matter more here than anywhere else.** Stripe retries any
 * response that is not 2xx, so `handleStripeEvent` answers `ok(null)` both
 * for a redelivery it has already applied and for an event type this system
 * does not handle -- a 200 in each case, and no retry storm.
 */
export const POST = route<undefined, null>({
  auth: 'public',
  handler: async ({ request }) => {
    const signature = request.headers.get('stripe-signature');
    if (!signature) return fail('VALIDATION_FAILED', { field: 'stripe-signature' });

    // The raw bytes, never a parsed-and-reprinted copy: the signature
    // covers these exact bytes, and a round trip through JSON would reorder
    // keys and drop whitespace.
    const payload = await request.text();

    let verified;
    try {
      verified = paymentProvider().verifyWebhook(payload, signature);
    } catch (error) {
      // `verifyWebhook` is contractually total -- every implementation
      // returns a `Result` -- but it is third-party-shaped code at the edge
      // of the system, and a webhook is the worst place to find out
      // otherwise. A provider that throws is the provider's failure, not
      // the caller's: 502, with the detail logged rather than returned.
      console.error('[stripe-webhook] payment provider threw while verifying', error);
      return fail('PAYMENT_PROVIDER_ERROR', { reason: 'verify_webhook_threw' });
    }
    if (!verified.ok) return verified;

    return handleStripeEvent(db(), await queue(), verified.value);
  },
});
