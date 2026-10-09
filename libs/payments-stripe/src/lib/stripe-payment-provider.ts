import { DateTime } from 'luxon';
import { createHmac } from 'node:crypto';
import { fail, ok, type Result } from '@rm/shared-utils';
import {
  isValidAmountCents,
  isValidCustomerEmail,
  isWithinLimits,
  parseStripeEventBody,
  timingSafeEqualStrings,
  type PaymentIntentMethod,
  type PaymentIntentRequest,
  type PaymentIntentResult,
  type PaymentProvider,
  type ProviderLimits,
  type WebhookEvent,
} from './payment-provider';

/**
 * A Stripe call that hangs must fail rather than stall the caller: `fetch`
 * has no timeout of its own. Ten seconds is far above Stripe's normal
 * latency; past it the call fails like any provider error.
 */
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
// Stripe's own default tolerance for a webhook signature's `t=` timestamp,
// used by every official Stripe SDK to reject a replayed request.
const SIGNATURE_TOLERANCE_SECONDS = 300;
// Stripe requires at least one whole day for `expires_after_days`; the
// upper bound is this adapter's own assumption about Stripe's documented
// maximum, unverified against a live account -- see the library README.
const MIN_OXXO_EXPIRES_AFTER_DAYS = 1;
const MAX_OXXO_EXPIRES_AFTER_DAYS = 31;

/** Stripe's `payment_method_types` value for each method this port exposes. */
function stripePaymentMethodType(method: PaymentIntentMethod): string {
  switch (method) {
    case 'CARD':
      return 'card';
    case 'OXXO':
      return 'oxxo';
    case 'SPEI':
      // Stripe models Mexican SPEI bank transfers through the
      // `customer_balance` payment method with a `mx_bank_transfer` funding
      // type, not a dedicated "spei" payment method type. Unverified
      // against a live account -- see the library README.
      return 'customer_balance';
  }
}

/**
 * Stripe's OXXO voucher expiry, as Stripe defines it: `expires_after_days = N`
 * expires the voucher at 23:59 America/Mexico_City on the Nth calendar day
 * after creation -- not N x 24 hours later. That zone is Stripe's, fixed by
 * Stripe, which is why it is a constant here and not the organisation's
 * `organization.timezone`.
 */
const STRIPE_OXXO_TIME_ZONE = 'America/Mexico_City';

/**
 * The `expires_after_days` to ask Stripe for so the voucher never outlives
 * `voucherExpiresAt` (the reservation's hold; business rule 5.3): the largest
 * N whose end of day -- 23:59:59.999 in Mexico City, N calendar days from
 * today there -- is still no later than it.
 *
 * An earlier version floored `(voucherExpiresAt - now) / 24h`, which treated
 * N as N x 24 hours: a hold ending at 13:00 tomorrow gave N = 1, and Stripe
 * kept the voucher payable until 23:59 tomorrow, ~11 hours after the seat
 * had been released (final review of the phase 2A branch).
 *
 * **Returns `undefined` when not even N = 1 fits.** Stripe has no "less than
 * a day", and widening the window to 1 would recreate the bug; the caller
 * (`createIntent`) refuses OXXO for that hold instead. Clamped at the top to
 * `MAX_OXXO_EXPIRES_AFTER_DAYS`.
 */
export function oxxoExpiresAfterDays(
  voucherExpiresAt: Date,
  now: Date = new Date(),
): number | undefined {
  const today = DateTime.fromJSDate(now, {
    zone: STRIPE_OXXO_TIME_ZONE,
  }).startOf('day');
  const holdEnds = DateTime.fromJSDate(voucherExpiresAt, {
    zone: STRIPE_OXXO_TIME_ZONE,
  });
  const lastFullDay = holdEnds.equals(holdEnds.endOf('day'))
    ? holdEnds.startOf('day')
    : holdEnds.startOf('day').minus({ days: 1 });
  const days = Math.round(lastFullDay.diff(today, 'days').days);
  if (days < MIN_OXXO_EXPIRES_AFTER_DAYS) return undefined;
  return Math.min(MAX_OXXO_EXPIRES_AFTER_DAYS, days);
}

/**
 * The inverse of `oxxoExpiresAfterDays`: the last instant a voucher created
 * at `now` with `expires_after_days = days` can be paid -- the end of the
 * `days`-th calendar day after `now` in Mexico City (Stripe's definition).
 *
 * An `ACTIVE` reservation has no hold to bound its voucher, so the domain asks
 * for its own validity in days (owner decision D3) and sends this as
 * `voucherExpiresAt`; `oxxoExpiresAfterDays` turns it back into exactly
 * `days`. The end of the day is 23:59:59.999, not 23:59:00, because that is
 * the instant `oxxoExpiresAfterDays` recognises as "this whole day".
 */
export function oxxoDeadlineAfterDays(days: number, now: Date = new Date()): Date {
  return DateTime.fromJSDate(now, { zone: STRIPE_OXXO_TIME_ZONE }).plus({ days }).endOf('day').toJSDate();
}

/**
 * Stripe's per-transaction limits for MXN as documented: MXN 10.00 minimum
 * for every method, and MXN 10,000.00 per OXXO voucher. **Unverified against
 * a live account** (abono libre spec §5.4, §13) -- see the library README.
 * `FakePaymentProvider` uses the same table, so tests meet the same limits.
 */
export const STRIPE_LIMITS: Readonly<Record<PaymentIntentMethod, ProviderLimits>> = {
  CARD: { minCents: 1_000, maxCents: null },
  OXXO: { minCents: 1_000, maxCents: 1_000_000 },
  SPEI: { minCents: 1_000, maxCents: null },
};

interface StripeOxxoDisplayDetails {
  hosted_voucher_url?: string;
  expires_after?: number;
}

interface StripePaymentIntentResponse {
  id: string;
  client_secret: string | null;
  next_action?: {
    oxxo_display_details?: StripeOxxoDisplayDetails;
  };
}

interface StripeErrorResponse {
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

/**
 * True for the one specific error Stripe returns when `cancelIntent` is
 * called a second time against an intent that is already in a terminal
 * `canceled` state: an `invalid_request_error` with code
 * `payment_intent_unexpected_state`. This adapter absorbs exactly that one
 * case into `ok(null)` so a second `cancelIntent` call is idempotent at the
 * port level too, the same guarantee `FakePaymentProvider` gives
 * unconditionally and the shared contract requires of every implementation.
 * Every other error (a bad id, a network failure, an intent that is
 * `succeeded` rather than `canceled`) still maps to `PAYMENT_PROVIDER_ERROR`.
 *
 * This mapping is based on Stripe's documented error shape for an intent
 * already in a terminal state and has never been exercised against a live
 * account -- see the library README and the Task 9 report.
 */
function isAlreadyCanceledError(error: StripeErrorResponse | undefined): boolean {
  return (
    error?.error?.code === 'payment_intent_unexpected_state' &&
    (error.error.message?.toLowerCase().includes('canceled') ?? false)
  );
}

async function parseJsonSafely<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Talks to the Stripe HTTP API directly (no SDK dependency), the same
 * choice `ResendEmailProvider` made for the same reason: one less
 * third-party dependency to vendor and keep current. There is no Stripe
 * account or API key in this environment, so this class is typechecked but
 * never executed here -- see the library README and the Task 9 report for
 * exactly what that does and does not prove.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string
  ) {}

  limitsFor(method: PaymentIntentMethod): ProviderLimits {
    return STRIPE_LIMITS[method];
  }

  async createIntent(request: PaymentIntentRequest): Promise<Result<PaymentIntentResult>> {
    if (!isValidAmountCents(request.amountCents)) {
      return fail('VALIDATION_FAILED', { field: 'amountCents' });
    }
    // The domain already refused this with a translatable code; reaching
    // here is the caller's bug, and Stripe would refuse it anyway.
    if (!isWithinLimits(request.amountCents, this.limitsFor(request.method))) {
      return fail('VALIDATION_FAILED', { field: 'amountCents', reason: 'outside_provider_limits' });
    }
    if (!isValidCustomerEmail(request.customerEmail)) {
      return fail('VALIDATION_FAILED', { field: 'customerEmail' });
    }
    if (request.method === 'OXXO' && !request.voucherExpiresAt) {
      return fail('VALIDATION_FAILED', { field: 'voucherExpiresAt' });
    }

    // Computed -- and, when it cannot be satisfied honestly, refused --
    // before any network call: Stripe's OXXO parameter only accepts a
    // whole number of days, and a window under 24 hours has no value that
    // is both whole and no later than requested (see `oxxoExpiresAfterDays`
    // for why clamping it up to 1 day would be the exact bug this guards
    // against). This is the caller's request shape being unsatisfiable,
    // not an upstream failure, so it is VALIDATION_FAILED (422) rather than
    // PAYMENT_PROVIDER_ERROR (502) -- same split as every other input
    // check in this method.
    let oxxoExpiresInDays: number | undefined;
    if (request.method === 'OXXO' && request.voucherExpiresAt) {
      oxxoExpiresInDays = oxxoExpiresAfterDays(request.voucherExpiresAt);
      if (oxxoExpiresInDays === undefined) {
        return fail('VALIDATION_FAILED', { field: 'voucherExpiresAt', reason: 'window_too_short_for_oxxo' });
      }
    }

    // `amountCents` is the only amount this call ever sends -- the backend
    // computed it from the reservation's own balance before this port was
    // ever reached (see the doc comment on `PaymentIntentRequest`), so there
    // is no customer-supplied number anywhere in this body to forward.
    const body = new URLSearchParams();
    body.set('amount', String(request.amountCents));
    body.set('currency', 'mxn');
    body.set('receipt_email', request.customerEmail);
    body.set('metadata[reservationId]', request.reservationId);
    body.set('payment_method_types[]', stripePaymentMethodType(request.method));

    if (oxxoExpiresInDays !== undefined) {
      body.set('payment_method_options[oxxo][expires_after_days]', String(oxxoExpiresInDays));
    }
    if (request.method === 'SPEI') {
      body.set('payment_method_options[customer_balance][funding_type]', 'bank_transfer');
      body.set('payment_method_options[customer_balance][bank_transfer][type]', 'mx_bank_transfer');
    }

    try {
      const response = await fetch(`${STRIPE_API_BASE_URL}/payment_intents`, {
        method: 'POST',
        signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        // The provider rejected or failed the request -- this is Stripe's
        // (or the network's) fault, never the caller's, so it is
        // PAYMENT_PROVIDER_ERROR (502) and not VALIDATION_FAILED (422).
        const error = await parseJsonSafely<StripeErrorResponse>(response);
        return fail('PAYMENT_PROVIDER_ERROR', { status: response.status, message: error?.error?.message });
      }

      const intent = (await response.json()) as StripePaymentIntentResponse;
      const result: PaymentIntentResult = {
        providerIntentId: intent.id,
        clientSecret: intent.client_secret ?? '',
      };
      if (request.method === 'OXXO') {
        const details = intent.next_action?.oxxo_display_details;
        result.voucherUrl = details?.hosted_voucher_url;
        // Prefer the expiry Stripe actually computed (day granularity,
        // floored towards now above) over echoing back the request's own
        // `voucherExpiresAt`: the two can legitimately differ by up to a day,
        // and the provider's own value is the one that matters for "does
        // this voucher outlive the hold".
        result.voucherExpiresAt = details?.expires_after
          ? new Date(details.expires_after * 1000)
          : request.voucherExpiresAt;
      }
      return ok(result);
    } catch (error) {
      // Network failure, timeout, DNS, etc. A customer must never see their
      // reservation break because Stripe (or the path to it) is down.
      return fail('PAYMENT_PROVIDER_ERROR', {
        reason: 'network_error',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  async cancelIntent(providerIntentId: string): Promise<Result<null>> {
    try {
      const response = await fetch(`${STRIPE_API_BASE_URL}/payment_intents/${providerIntentId}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });

      if (response.ok) return ok(null);

      const error = await parseJsonSafely<StripeErrorResponse>(response);
      if (isAlreadyCanceledError(error)) {
        return ok(null);
      }
      return fail('PAYMENT_PROVIDER_ERROR', { status: response.status, message: error?.error?.message });
    } catch (error) {
      return fail('PAYMENT_PROVIDER_ERROR', {
        reason: 'network_error',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  verifyWebhook(payload: string, signature: string): Result<WebhookEvent> {
    const header = parseStripeSignatureHeader(signature);
    if (!header) {
      return fail('VALIDATION_FAILED', { reason: 'malformed_signature_header' });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - header.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      return fail('VALIDATION_FAILED', { reason: 'signature_timestamp_outside_tolerance' });
    }

    const expectedSignature = createHmac('sha256', this.webhookSecret)
      .update(`${header.timestamp}.${payload}`, 'utf8')
      .digest('hex');
    const matches = header.v1Signatures.some((candidate) => timingSafeEqualStrings(candidate, expectedSignature));
    if (!matches) {
      return fail('VALIDATION_FAILED', { reason: 'invalid_signature' });
    }

    // Shared with `FakePaymentProvider`: once the signature holds, both
    // adapters read the same Stripe event shape through the same parser, so
    // the fake can never quietly diverge from this one on what an event
    // means (see `parseStripeEventBody`).
    return parseStripeEventBody(payload);
  }
}

/**
 * Parses Stripe's `Stripe-Signature` header, shaped like
 * `t=1614556800,v1=abc...,v1=def...` -- more than one `v1` entry appears
 * during a webhook signing secret rotation, and this collects every one of
 * them so `verifyWebhook` accepts a match against any of them.
 */
function parseStripeSignatureHeader(header: string): { timestamp: number; v1Signatures: string[] } | undefined {
  let timestamp: number | undefined;
  const v1Signatures: string[] = [];

  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) v1Signatures.push(value);
  }

  if (timestamp === undefined || Number.isNaN(timestamp) || v1Signatures.length === 0) {
    return undefined;
  }
  return { timestamp, v1Signatures };
}
