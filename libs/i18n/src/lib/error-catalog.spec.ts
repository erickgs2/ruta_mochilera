import { describe, expect, it } from 'vitest';
import type { DomainErrorCode } from '@rm/shared-utils';
import es from '../assets/es.json';
import en from '../assets/en.json';

/**
 * `DomainErrorCode` is the authoritative list of codes the backend's domain
 * layer can return; `INTERNAL_ERROR` is added on top because the HTTP layer
 * itself emits it (e.g. an uncaught exception) and it is not part of that
 * union. Every one of them must have a non-empty translation in both
 * catalogues, or `ErrorCodePipe` would either show a raw code or an empty
 * string to a user.
 *
 * The list below is spelled out by hand (not derived from the type, which
 * does not exist at runtime) and paired with the exhaustiveness switch in
 * `assertKnownCode`: if `DomainErrorCode` ever gains a member that isn't
 * added here too, that switch fails to compile, so this test cannot pass
 * silently on a stale list.
 */
const ALL_DOMAIN_ERROR_CODES: readonly DomainErrorCode[] = [
  'INVALID_CREDENTIALS',
  'TOKEN_INVALID',
  'TOKEN_REUSED',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_ALREADY_REGISTERED',
  'ACCOUNT_DISABLED',
  'RATE_LIMITED',
  'PERMISSION_DENIED',
  'SYSTEM_ROLE_IMMUTABLE',
  'ROLE_IN_USE',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'UNSUPPORTED_MEDIA_TYPE',
  'CONFLICT',
  'INVALID_CAPACITY',
  'CAPACITY_BELOW_COMMITTED',
  'TRIP_NOT_PUBLISHABLE',
  'INVALID_STATUS_TRANSITION',
  'TRIP_SOLD_OUT',
  'TRIP_NOT_PUBLISHED',
  'MISSING_REQUIRED_TRANSLATION',
  'DUPLICATE_RESERVATION',
  'RESERVATION_NOT_OWNED',
  'PAYMENT_DEADLINE_PASSED',
  'HOLD_EXPIRED',
  'PAYMENT_EXCEEDS_BALANCE',
  'DEPOSIT_BELOW_MINIMUM',
  'DELIVERY_NOT_OWNED',
  'EMAIL_PROVIDER_ERROR',
];

/** Compile-time guard: fails to build if `DomainErrorCode` gains a case not listed above. */
function assertKnownCode(code: DomainErrorCode): void {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'TOKEN_INVALID':
    case 'TOKEN_REUSED':
    case 'EMAIL_NOT_VERIFIED':
    case 'EMAIL_ALREADY_REGISTERED':
    case 'ACCOUNT_DISABLED':
    case 'RATE_LIMITED':
    case 'PERMISSION_DENIED':
    case 'SYSTEM_ROLE_IMMUTABLE':
    case 'ROLE_IN_USE':
    case 'NOT_FOUND':
    case 'VALIDATION_FAILED':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'CONFLICT':
    case 'INVALID_CAPACITY':
    case 'CAPACITY_BELOW_COMMITTED':
    case 'TRIP_NOT_PUBLISHABLE':
    case 'INVALID_STATUS_TRANSITION':
    case 'TRIP_SOLD_OUT':
    case 'TRIP_NOT_PUBLISHED':
    case 'MISSING_REQUIRED_TRANSLATION':
    case 'DUPLICATE_RESERVATION':
    case 'RESERVATION_NOT_OWNED':
    case 'PAYMENT_DEADLINE_PASSED':
    case 'HOLD_EXPIRED':
    case 'PAYMENT_EXCEEDS_BALANCE':
    case 'DEPOSIT_BELOW_MINIMUM':
    case 'DELIVERY_NOT_OWNED':
    case 'EMAIL_PROVIDER_ERROR':
      return;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled DomainErrorCode: ${String(exhaustive)}`);
    }
  }
}

/** Codes the HTTP layer can emit that are not part of the domain's `DomainErrorCode` union. */
const EXTRA_HTTP_CODES = ['INTERNAL_ERROR'] as const;

const codesToCover: readonly string[] = [...ALL_DOMAIN_ERROR_CODES, ...EXTRA_HTTP_CODES];

describe('error translation catalogues', () => {
  it('is exhaustive against the DomainErrorCode union', () => {
    for (const code of ALL_DOMAIN_ERROR_CODES) assertKnownCode(code);
    expect(ALL_DOMAIN_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it.each(codesToCover)('es.json has a non-empty translation for %s', (code) => {
    const message = (es.errors as Record<string, string | undefined>)[code];
    expect(message).toBeTruthy();
    expect(message).not.toBe(code);
  });

  it.each(codesToCover)('en.json has a non-empty translation for %s', (code) => {
    const message = (en.errors as Record<string, string | undefined>)[code];
    expect(message).toBeTruthy();
    expect(message).not.toBe(code);
  });

  it('both catalogues also provide a generic fallback for an unrecognized code', () => {
    expect(es.errors.UNKNOWN).toBeTruthy();
    expect(en.errors.UNKNOWN).toBeTruthy();
  });
});
