import { timingSafeEqual } from 'node:crypto';
import { fail, ok, type Result } from '@rm/shared-utils';

export type PaymentIntentMethod = 'CARD' | 'OXXO' | 'SPEI';

/**
 * What the backend asks a provider to create a Payment Intent for.
 *
 * **The backend decides the amount, always.** `amountCents` is the amount
 * the backend itself computed from the reservation's own balance (see
 * `@rm/domain-payments`'s `balanceOf`) -- there is no "requested amount" or
 * "client amount" field anywhere on this interface for a route handler to
 * forward a customer-supplied number into. A caller that wanted to charge
 * whatever a customer's request body said would have to invent a field this
 * type does not have; the only amount this port can ever be asked to charge
 * is one the backend itself put here.
 */
export interface PaymentIntentRequest {
  reservationId: string;
  amountCents: number;
  method: PaymentIntentMethod;
  customerEmail: string;
  /**
   * Required when `method` is `'OXXO'`, ignored otherwise (checked by every
   * implementation, not just documented here). The caller must pass the
   * reservation's own `holdExpiresAt` -- the voucher must never outlive the
   * hold it is paying for, or the system could end up confirming a payment
   * for a seat it has already released back into inventory (business rule
   * 5.3).
   */
  voucherExpiresAt?: Date;
}

export interface PaymentIntentResult {
  providerIntentId: string;
  clientSecret: string;
  /** Present only for an OXXO intent. */
  voucherUrl?: string;
  /**
   * Present only for an OXXO intent. **Never later than the request's own
   * `voucherExpiresAt`** -- an implementation may return an earlier moment
   * (Stripe's own OXXO parameter has only day granularity, so its real
   * voucher commonly expires earlier than requested; see
   * `StripePaymentProvider`'s `oxxoExpiresAfterDays`), but must never
   * return a later one, or a payment could be confirmed for a seat the
   * hold already released (business rule 5.3). Not guaranteed to equal the
   * request -- see `runPaymentContract`.
   */
  voucherExpiresAt?: Date;
}

/**
 * Stripe's `last_payment_error.code` when an OXXO voucher reached its
 * expiry without being paid.
 *
 * Stripe has no dedicated "voucher expired" event type: an unpaid voucher
 * ends its life as an ordinary `payment_intent.payment_failed`, and this
 * code on the intent is the only thing that tells it apart from a declined
 * card. The distinction matters downstream -- an expired voucher leaves the
 * payment `EXPIRED` and tells the customer their slip ran out, a decline
 * leaves it `FAILED` and tells them to try again -- so the port surfaces the
 * code rather than collapsing both into one outcome.
 *
 * Never verified against a live Stripe account; see the library README.
 */
export const OXXO_VOUCHER_EXPIRED_FAILURE_CODE = 'payment_intent_payment_attempt_expired';

/** The `payment_intent.*` detail of a webhook event. Absent for every other event type. */
export interface WebhookPaymentIntent {
  providerIntentId: string;
  /** The intent's amount, in MXN cents. */
  amountCents: number;
  /** Derived from the intent's `payment_method_types`, when it names one of the three methods this port issues. */
  method?: PaymentIntentMethod;
  /**
   * The reservation from the intent's `metadata[reservationId]`, which
   * `createIntent` always sets. Absent for an intent created outside this
   * system (the Stripe dashboard, say), which is exactly the case the
   * webhook has to escalate rather than record.
   */
  reservationId?: string;
  /** Stripe's `last_payment_error.code`, present on a failure. See `OXXO_VOUCHER_EXPIRED_FAILURE_CODE`. */
  failureCode?: string;
}

export interface WebhookEvent {
  /**
   * Stripe's own event id (`evt_...`). **This is the idempotency key**: it
   * is the primary key of `stripe_events`, and inserting that row is the
   * first thing `handleStripeEvent` does inside its transaction.
   */
  id: string;
  /**
   * Stripe's event type verbatim, as a plain `string` rather than a union
   * of the ones this system acts on.
   *
   * Stripe sends hundreds of event types down one endpoint and retries
   * anything that is not a 2xx, so an event we simply do not care about
   * must never come back as an error -- it would be retried forever. The
   * port reports every well-formed event faithfully and
   * `handleStripeEvent`'s own `switch` is the list of the ones that mean
   * something.
   */
  type: string;
  occurredAt: Date;
  /** The parsed event body, stored verbatim in `stripe_events.payload`. */
  payload: Record<string, unknown>;
  /** Present only for a `payment_intent.*` event. */
  intent?: WebhookPaymentIntent;
}

export interface PaymentProvider {
  createIntent(request: PaymentIntentRequest): Promise<Result<PaymentIntentResult>>;
  cancelIntent(providerIntentId: string): Promise<Result<null>>;
  /**
   * Verifies the signature over the raw webhook body and, if it holds,
   * parses the event. Synchronous and never throws: every implementation
   * returns a `Result`, including for a malformed header or body.
   */
  verifyWebhook(payload: string, signature: string): Result<WebhookEvent>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal recipient shape check shared by every `PaymentProvider`
 * implementation, so a malformed address is rejected the same way
 * everywhere -- the same role `@rm/email`'s `isValidEmailAddress` plays.
 */
export function isValidCustomerEmail(address: string): boolean {
  return EMAIL_PATTERN.test(address);
}

/** Money is always `Int` cents (constraints.md) -- a fractional or non-positive amount is the caller's bug, not the provider's. */
export function isValidAmountCents(amountCents: number): boolean {
  return Number.isInteger(amountCents) && amountCents > 0;
}

/**
 * Reserved `reservationId` that signals a simulated provider-level
 * rejection of `createIntent`, instead of a real call to Stripe --
 * analogous to `@rm/email`'s `PROVIDER_REJECTED_TEST_ADDRESS`. Exists so
 * the shared contract test can prove a provider failure comes back as a
 * `Result` and never as a thrown exception, without needing a live failure
 * from Stripe. `FakePaymentProvider` honors it directly; it is never a real
 * reservation id.
 */
export const PROVIDER_REJECTED_TEST_RESERVATION_ID = 'test-provider-rejects-create-intent';

/**
 * Reserved `reservationId` that signals a simulated provider-level
 * rejection of a *later* `cancelIntent` call against the intent `createIntent`
 * returns for it -- a second sentinel because `createIntent` and
 * `cancelIntent` fail at different moments, and the `expireHolds` wiring
 * (Task 9, Step 3) specifically needs to prove that a cancellation failure
 * at the provider does not stop a reservation from expiring.
 */
export const PROVIDER_CANCEL_REJECTED_TEST_RESERVATION_ID = 'test-provider-rejects-cancel-intent';

/**
 * Constant-time string comparison, shared by every implementation that
 * verifies a webhook signature (`FakePaymentProvider` and
 * `StripePaymentProvider` both need it) so neither one is tempted to fall
 * back to `===`, which leaks timing information about how many leading
 * bytes matched.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Stripe's `payment_method_types` values, mapped back to this port's own methods. */
const METHOD_BY_STRIPE_TYPE: Record<string, PaymentIntentMethod> = {
  card: 'CARD',
  oxxo: 'OXXO',
  // Stripe models Mexican SPEI transfers as `customer_balance`; see
  // `stripePaymentMethodType` in `stripe-payment-provider.ts`.
  customer_balance: 'SPEI',
};

/** Shape of the pieces of a Stripe event body this port reads. Everything else is kept only in `payload`. */
interface StripeEventBody {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: Record<string, unknown> };
}

function readIntent(object: Record<string, unknown>): WebhookPaymentIntent | undefined {
  const providerIntentId = object['id'];
  const amount = object['amount'];
  if (typeof providerIntentId !== 'string' || typeof amount !== 'number') return undefined;

  const methodTypes = object['payment_method_types'];
  const firstType = Array.isArray(methodTypes) ? methodTypes[0] : undefined;
  const metadata = object['metadata'];
  const reservationId =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)['reservationId']
      : undefined;
  const lastError = object['last_payment_error'];
  const failureCode =
    typeof lastError === 'object' && lastError !== null
      ? (lastError as Record<string, unknown>)['code']
      : undefined;

  return {
    providerIntentId,
    // Stripe amounts are already in the currency's minor unit, which for MXN
    // is centavos -- the same unit every `Int` amount in this system uses.
    amountCents: amount,
    method: typeof firstType === 'string' ? METHOD_BY_STRIPE_TYPE[firstType] : undefined,
    reservationId: typeof reservationId === 'string' ? reservationId : undefined,
    failureCode: typeof failureCode === 'string' ? failureCode : undefined,
  };
}

/**
 * Parses a webhook body into a `WebhookEvent`, shared by every
 * `PaymentProvider` implementation so the fake and Stripe can never drift
 * apart on what an event *means* -- they differ only in how the signature
 * over those bytes is computed.
 *
 * **Never rejects an event for its type.** Only a body that is not JSON, or
 * that lacks the three fields every Stripe event has (`id`, `type`,
 * `created`), comes back as a failure. An event type this system does not
 * act on parses like any other and is ignored downstream, because Stripe
 * retries on every non-2xx response and an error here would make it retry
 * that event forever.
 *
 * The `payment_intent.*` detail is read only when the event's object
 * actually looks like a Payment Intent, so a `customer.created` delivered to
 * the same endpoint simply arrives with no `intent`.
 */
export function parseStripeEventBody(payload: string): Result<WebhookEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // The signature already checked out, which only means the caller holds
    // the webhook secret -- it says nothing about the body being well-formed.
    return fail('VALIDATION_FAILED', { reason: 'malformed_webhook_payload' });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('VALIDATION_FAILED', { reason: 'malformed_webhook_payload' });
  }

  const body = parsed as StripeEventBody;
  if (typeof body.id !== 'string' || typeof body.type !== 'string' || typeof body.created !== 'number') {
    return fail('VALIDATION_FAILED', { reason: 'malformed_webhook_payload' });
  }

  const object = body.data?.object;
  const intent =
    body.type.startsWith('payment_intent.') && typeof object === 'object' && object !== null
      ? readIntent(object)
      : undefined;

  return ok({
    id: body.id,
    type: body.type,
    occurredAt: new Date(body.created * 1000),
    payload: parsed as Record<string, unknown>,
    intent,
  });
}
