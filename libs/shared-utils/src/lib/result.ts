export type DomainErrorCode =
  // Authentication and identity
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_INVALID'
  | 'TOKEN_REUSED'
  | 'EMAIL_NOT_VERIFIED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'ACCOUNT_DISABLED'
  | 'RATE_LIMITED'
  // Email verification and password reset (Phase 2A, Tasks 11-12)
  | 'OTP_EXPIRED'
  | 'OTP_INVALID'
  | 'OTP_MAX_ATTEMPTS'
  | 'OTP_RESEND_TOO_SOON'
  // Authorization
  | 'PERMISSION_DENIED'
  | 'SYSTEM_ROLE_IMMUTABLE'
  | 'ROLE_IN_USE'
  // Generic
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'CONFLICT'
  // Trips and costing
  | 'INVALID_CAPACITY'
  | 'CAPACITY_BELOW_COMMITTED'
  | 'TRIP_NOT_PUBLISHABLE'
  | 'INVALID_STATUS_TRANSITION'
  | 'TRIP_SOLD_OUT'
  | 'TRIP_NOT_PUBLISHED'
  | 'MISSING_REQUIRED_TRANSLATION'
  // Reservations and payments (Phase 2)
  | 'DUPLICATE_RESERVATION'
  | 'RESERVATION_NOT_OWNED'
  | 'PAYMENT_DEADLINE_PASSED'
  | 'HOLD_EXPIRED'
  | 'PAYMENT_EXCEEDS_BALANCE'
  | 'DEPOSIT_BELOW_MINIMUM'
  // Notifications (Phase 2)
  // 404 and not 403, same reasoning as `RESERVATION_NOT_OWNED`: a 403 would
  // confirm the delivery exists, which lets a customer walking ids tell
  // "not yours" from "no such delivery".
  | 'DELIVERY_NOT_OWNED'
  // Outbound providers (Phase 2) -- the provider or network failed, not the
  // caller's input. Each of these is a 5xx in STATUS_BY_CODE, unlike every
  // other code in this union, which is a client-side fault.
  | 'EMAIL_PROVIDER_ERROR'
  | 'PAYMENT_PROVIDER_ERROR';

export interface DomainError {
  code: DomainErrorCode;
  details?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: DomainErrorCode, details?: Record<string, unknown>): Result<never> {
  return { ok: false, error: { code, details } };
}

/** Narrowing helper for call sites that only care about the failure branch. */
export function isFailure<T>(result: Result<T>): result is { ok: false; error: DomainError } {
  return !result.ok;
}
