import type { DomainError, DomainErrorCode } from '@rm/shared-utils';

/**
 * Declared `Record<DomainErrorCode, number>` on purpose: TypeScript enforces
 * that every member of the 28-code union has an entry here. Adding a new
 * `DomainErrorCode` without updating this map is a typecheck failure, not a
 * silent 500 discovered later.
 */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  EMAIL_NOT_VERIFIED: 403,
  EMAIL_ALREADY_REGISTERED: 409,
  ACCOUNT_DISABLED: 403,
  RATE_LIMITED: 429,
  // Not a 5xx: this is a known, stable configuration state (no Google/Apple
  // developer account for this build yet), not an unexpected failure on our
  // side -- so not EMAIL_PROVIDER_ERROR/PAYMENT_PROVIDER_ERROR's 502 either.
  // 503 reads correctly to a client: this specific sign-in method is
  // unavailable right now, try a different one.
  PROVIDER_DISABLED: 503,
  // 422: the caller's input (the code itself) is what is wrong, the same
  // status VALIDATION_FAILED uses -- not 401, which would suggest a missing
  // or malformed credential rather than a wrong one-time code.
  OTP_EXPIRED: 422,
  OTP_INVALID: 422,
  OTP_MAX_ATTEMPTS: 422,
  OTP_RESEND_TOO_SOON: 429,
  PERMISSION_DENIED: 403,
  SYSTEM_ROLE_IMMUTABLE: 403,
  ROLE_IN_USE: 409,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CONFLICT: 409,
  INVALID_CAPACITY: 422,
  CAPACITY_BELOW_COMMITTED: 409,
  TRIP_NOT_PUBLISHABLE: 409,
  INVALID_STATUS_TRANSITION: 409,
  TRIP_SOLD_OUT: 409,
  TRIP_NOT_PUBLISHED: 409,
  MISSING_REQUIRED_TRANSLATION: 422,
  DUPLICATE_RESERVATION: 409,
  // 404 and not 403 on purpose: a 403 would confirm that the reservation
  // exists, which lets a customer walking ids tell "not yours" from "no such
  // reservation". The domain returns this same code for both cases.
  RESERVATION_NOT_OWNED: 404,
  PAYMENT_DEADLINE_PASSED: 409,
  HOLD_EXPIRED: 409,
  PAYMENT_EXCEEDS_BALANCE: 422,
  DEPOSIT_BELOW_MINIMUM: 422,
  NO_CANCELLATION_REQUEST: 409,
  CUSTOMER_ALREADY_EXISTS: 409,
  CREDIT_INSUFFICIENT: 409,
  NO_PRICE_CHANGE: 409,
  IMPORT_TOO_LARGE: 413,
  IMPORT_ALREADY_APPLIED: 409,
  // Same reasoning as RESERVATION_NOT_OWNED above: a 403 would confirm the
  // delivery exists.
  DELIVERY_NOT_OWNED: 404,
  // The first 5xx in this map: every code above is a client-side fault, this
  // one is ours (or our upstream's) -- the email provider or the network
  // path to it failed, not the caller's input.
  EMAIL_PROVIDER_ERROR: 502,
  // Same split as EMAIL_PROVIDER_ERROR, Ruling 10: Stripe (or the network
  // path to it) failed, not the caller's input, so it is a 502 and never
  // VALIDATION_FAILED.
  PAYMENT_PROVIDER_ERROR: 502,
};

export function statusForCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Renders a domain error as RFC 7807 problem+json.
 * The payload carries a stable `code` and never human-facing prose: the client
 * translates the code into the user's language.
 */
export function problemResponse(error: DomainError): Response {
  const status = statusForCode(error.code);
  return new Response(
    JSON.stringify({
      type: `https://rutamochilera.app/errors/${error.code.toLowerCase()}`,
      title: error.code,
      status,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } }
  );
}
