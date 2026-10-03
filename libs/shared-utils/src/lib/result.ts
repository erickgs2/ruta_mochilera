export type DomainErrorCode =
  // Authentication and identity
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_INVALID'
  | 'TOKEN_REUSED'
  | 'EMAIL_NOT_VERIFIED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'ACCOUNT_DISABLED'
  | 'RATE_LIMITED'
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
  | 'MISSING_REQUIRED_TRANSLATION'
  // Reservations and payments (Phase 2)
  | 'DUPLICATE_RESERVATION'
  | 'HOLD_EXPIRED'
  | 'PAYMENT_EXCEEDS_BALANCE'
  | 'DEPOSIT_BELOW_MINIMUM';

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
