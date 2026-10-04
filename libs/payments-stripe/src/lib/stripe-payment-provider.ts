import { createHmac } from 'node:crypto';
import { fail, ok, type Result } from '@rm/shared-utils';
import {
  isValidAmountCents,
  isValidCustomerEmail,
  parseStripeEventBody,
  timingSafeEqualStrings,
  type PaymentIntentMethod,
  type PaymentIntentRequest,
  type PaymentIntentResult,
  type PaymentProvider,
  type WebhookEvent,
} from './payment-provider';

const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe's own default tolerance for a webhook signature's `t=` timestamp,
// used by every official Stripe SDK to reject a replayed request.
const SIGNATURE_TOLERANCE_SECONDS = 300;

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
 * Stripe's OXXO payment method option only accepts a whole number of days
 * from intent creation (`expires_after_days`), not an exact timestamp --
 * unlike this port's own `voucherExpiresAt`, which is a `Date`. This floors
 * the remaining time toward now rather than rounding or ceiling, the only
 * direction that cannot push the voucher's actual expiry past the
 * reservation's `holdExpiresAt`: a ceiling could ask Stripe to keep the
 * voucher alive for up to a day after the hold releases the seat, exactly
 * the gap business rule 5.3 exists to close. Clamped to ``[1, 31]``: Stripe
 * requires at least one day, and this adapter assumes (unverified) that the
 * documented upper bound is 31.
 */
export function oxxoExpiresAfterDays(voucherExpiresAt: Date, now: Date = new Date()): number {
  const daysRemaining = Math.floor((voucherExpiresAt.getTime() - now.getTime()) / DAY_MS);
  return Math.min(31, Math.max(1, daysRemaining));
}

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

  async createIntent(request: PaymentIntentRequest): Promise<Result<PaymentIntentResult>> {
    if (!isValidAmountCents(request.amountCents)) {
      return fail('VALIDATION_FAILED', { field: 'amountCents' });
    }
    if (!isValidCustomerEmail(request.customerEmail)) {
      return fail('VALIDATION_FAILED', { field: 'customerEmail' });
    }
    if (request.method === 'OXXO' && !request.voucherExpiresAt) {
      return fail('VALIDATION_FAILED', { field: 'voucherExpiresAt' });
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

    if (request.method === 'OXXO' && request.voucherExpiresAt) {
      body.set(
        'payment_method_options[oxxo][expires_after_days]',
        String(oxxoExpiresAfterDays(request.voucherExpiresAt))
      );
    }
    if (request.method === 'SPEI') {
      body.set('payment_method_options[customer_balance][funding_type]', 'bank_transfer');
      body.set('payment_method_options[customer_balance][bank_transfer][type]', 'mx_bank_transfer');
    }

    try {
      const response = await fetch(`${STRIPE_API_BASE_URL}/payment_intents`, {
        method: 'POST',
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
