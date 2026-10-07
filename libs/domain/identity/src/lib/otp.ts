import { createHash, randomInt } from 'node:crypto';
import type { Db } from '@rm/db';

export interface GeneratedOtp {
  /** The plaintext six-digit code. Exists only in memory and in the email it is sent in -- never persisted. */
  code: string;
  /** The only form ever written to `EmailVerification.codeHash`. */
  codeHash: string;
}

/**
 * Generates a six-digit numeric verification code and its hash in one call,
 * so a caller can never accidentally persist `code` instead of `codeHash`.
 *
 * A million possibilities is not much entropy on its own -- it is
 * `otp.max_attempts` (see `loadOtpSettings`), not the hash, that actually
 * protects this code from being guessed. The hash exists only so the code
 * is never recoverable from a database dump, the same rule `hashRefreshToken`
 * already applies to refresh tokens.
 */
export function generateOtpCode(): GeneratedOtp {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  return { code, codeHash: hashOtpCode(code) };
}

/**
 * SHA-256 of the plaintext code, hex-encoded. Deliberately not `hashPassword`
 * (argon2id): a six-digit code has only a million possibilities, so a slow
 * password hash would spend meaningful CPU for no security gain -- it is the
 * attempt cap that defends this value, not the hash's cost. Kept as its own
 * tiny function (not a reuse of `hashRefreshToken` in `./tokens.ts`) so this
 * module stays decoupled from a name that talks about refresh tokens.
 */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface OtpSettings {
  ttlMinutes: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  maxResendsPerHour: number;
}

/** Seed defaults (`libs/db/prisma/seed.ts`), used only when a database has run migrations but never the seed. */
const DEFAULT_OTP_SETTINGS: OtpSettings = {
  ttlMinutes: 15,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  maxResendsPerHour: 5,
};

async function readNumberSetting(db: Db, key: string, fallback: number): Promise<number> {
  const setting = await db.systemSetting.findUnique({ where: { key } });
  return typeof setting?.value === 'number' ? setting.value : fallback;
}

/**
 * Reads the four OTP knobs from `SystemSetting`, falling back to the seed's
 * own defaults when a row is missing. Never a hardcoded constant in the
 * registration/verification flow itself -- see `constraints.md`'s rule that
 * calendar and policy values live in `SystemSetting`, read fresh on every
 * call rather than cached, so an administrator's change takes effect
 * immediately.
 */
export async function loadOtpSettings(db: Db): Promise<OtpSettings> {
  const [ttlMinutes, maxAttempts, resendCooldownSeconds, maxResendsPerHour] = await Promise.all([
    readNumberSetting(db, 'otp.ttl_minutes', DEFAULT_OTP_SETTINGS.ttlMinutes),
    readNumberSetting(db, 'otp.max_attempts', DEFAULT_OTP_SETTINGS.maxAttempts),
    readNumberSetting(db, 'otp.resend_cooldown_seconds', DEFAULT_OTP_SETTINGS.resendCooldownSeconds),
    readNumberSetting(db, 'otp.max_resends_per_hour', DEFAULT_OTP_SETTINGS.maxResendsPerHour),
  ]);
  return { ttlMinutes, maxAttempts, resendCooldownSeconds, maxResendsPerHour };
}
