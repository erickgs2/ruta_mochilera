import type { DomainError, DomainErrorCode } from '@rm/shared-utils';

/**
 * Declared `Record<DomainErrorCode, number>` on purpose: TypeScript enforces
 * that every member of the 23-code union has an entry here. Adding a new
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
  PERMISSION_DENIED: 403,
  SYSTEM_ROLE_IMMUTABLE: 403,
  ROLE_IN_USE: 409,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  INVALID_CAPACITY: 422,
  CAPACITY_BELOW_COMMITTED: 409,
  TRIP_NOT_PUBLISHABLE: 409,
  INVALID_STATUS_TRANSITION: 409,
  TRIP_SOLD_OUT: 409,
  MISSING_REQUIRED_TRANSLATION: 422,
  DUPLICATE_RESERVATION: 409,
  HOLD_EXPIRED: 409,
  PAYMENT_EXCEEDS_BALANCE: 422,
  DEPOSIT_BELOW_MINIMUM: 422,
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
