import { timingSafeEqual } from 'node:crypto';
import type { Result } from '@rm/shared-utils';

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
  /** Present only for an OXXO intent; echoes the request's own `voucherExpiresAt`. */
  voucherExpiresAt?: Date;
}

export type WebhookEventType =
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_intent.canceled';

export interface WebhookEvent {
  type: WebhookEventType;
  providerIntentId: string;
  occurredAt: Date;
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
