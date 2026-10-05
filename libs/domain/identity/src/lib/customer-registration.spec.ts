import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { ok } from '@rm/shared-utils';
import { hashOtpCode } from './otp';
import { resetRateLimiterForTesting } from './rate-limiter';
import { registerCustomer, resendVerificationCode, verifyEmail, type RegisterCustomerInput } from './customer-registration';

const db = withTestDb();

class FakeEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return ok({ providerMessageId: `fake-${this.sent.length}` });
  }
}

function extractCode(message: EmailMessage): string {
  const match = message.text.match(/\d{6}/);
  if (!match) throw new Error(`no six-digit code found in email body: ${message.text}`);
  return match[0];
}

const validInput: RegisterCustomerInput = {
  email: 'new.customer@example.com',
  password: 'Correct-Horse-1',
  fullName: 'Nueva Clienta',
  phone: '+52 55 1234 5678',
  birthDate: new Date('1990-01-01'),
  acceptTerms: true,
};

describe('registerCustomer / verifyEmail / resendVerificationCode', () => {
  let email: FakeEmailProvider;

  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    resetRateLimiterForTesting();
    email = new FakeEmailProvider();
  });

  afterAll(() => closeTestDb());

  describe('registerCustomer', () => {
    it('creates an unverified customer and emails a six-digit code', async () => {
      const result = await registerCustomer(db, email, validInput, '10.0.0.1');
      expect(result.ok).toBe(true);

      const user = await db.user.findUniqueOrThrow({ where: { email: 'new.customer@example.com' } });
      expect(user.type).toBe('CUSTOMER');
      expect(user.emailVerifiedAt).toBeNull();

      expect(email.sent).toHaveLength(1);
      expect(extractCode(email.sent[0]!)).toMatch(/^\d{6}$/);
    });

    it('stores the code hashed, never in clear: reading the row back never equals what was sent', async () => {
      await registerCustomer(db, email, validInput, '10.0.0.2');
      const sentCode = extractCode(email.sent[0]!);

      const user = await db.user.findUniqueOrThrow({ where: { email: 'new.customer@example.com' } });
      const row = await db.emailVerification.findFirstOrThrow({ where: { userId: user.id } });

      expect(row.codeHash).not.toBe(sentCode);
      expect(row.codeHash).toBe(hashOtpCode(sentCode));
    });

    it('does not reveal that an email is already registered: same response, and a different email reaches the real owner', async () => {
      await registerCustomer(db, email, validInput, '10.0.0.3');
      expect(email.sent).toHaveLength(1);
      const firstVerificationCode = extractCode(email.sent[0]!);

      const secondAttempt = await registerCustomer(
        db,
        email,
        { ...validInput, fullName: 'Attacker Pretending' },
        '10.0.0.4'
      );

      // Same success shape as the first, genuine registration.
      expect(secondAttempt.ok).toBe(true);

      // No second account was created.
      const users = await db.user.findMany({ where: { email: 'new.customer@example.com' } });
      expect(users).toHaveLength(1);

      // A second email went out, but it is not another verification code --
      // the real owner is notified, not handed a new OTP for an account they
      // did not ask to re-register.
      expect(email.sent).toHaveLength(2);
      expect(email.sent[1]!.text).not.toMatch(/\d{6}/);
      expect(email.sent[1]!.text).not.toBe(email.sent[0]!.text);
      expect(() => extractCode(email.sent[1]!)).toThrow();
      // The original code is still intact and usable -- the attempt did not
      // touch the first registration's EmailVerification row.
      const verify = await verifyEmail(db, { email: 'new.customer@example.com', code: firstVerificationCode });
      expect(verify.ok).toBe(true);
    });

    it('is rate-limited by email+ip, reusing the shared limiter', async () => {
      for (let i = 0; i < 5; i += 1) {
        const result = await registerCustomer(
          db,
          email,
          { ...validInput, email: `person-${i}@example.com` },
          '10.0.0.5'
        );
        expect(result.ok).toBe(true);
      }

      const sixth = await registerCustomer(db, email, { ...validInput, email: 'person-6@example.com' }, '10.0.0.5');
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('verifyEmail', () => {
    it('marks email_verified_at on a correct code and consumes it: reuse fails', async () => {
      await registerCustomer(db, email, validInput, '10.0.1.1');
      const code = extractCode(email.sent[0]!);

      const first = await verifyEmail(db, { email: validInput.email, code });
      expect(first.ok).toBe(true);

      const user = await db.user.findUniqueOrThrow({ where: { email: validInput.email } });
      expect(user.emailVerifiedAt).not.toBeNull();

      const profile = await db.customerProfile.findUniqueOrThrow({ where: { userId: user.id } });
      expect(profile.activatedAt).not.toBeNull();

      const second = await verifyEmail(db, { email: validInput.email, code });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('OTP_INVALID');
    });

    it('rejects a wrong code with OTP_INVALID', async () => {
      await registerCustomer(db, email, validInput, '10.0.1.2');
      const result = await verifyEmail(db, { email: validInput.email, code: '000000' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('OTP_INVALID');
    });

    it('expires according to SystemSetting otp.ttl_minutes, not a hardcoded constant', async () => {
      await db.systemSetting.create({ data: { key: 'otp.ttl_minutes', value: 30 } });
      await registerCustomer(db, email, validInput, '10.0.1.3');
      const code = extractCode(email.sent[0]!);

      const user = await db.user.findUniqueOrThrow({ where: { email: validInput.email } });
      const row = await db.emailVerification.findFirstOrThrow({ where: { userId: user.id } });
      const minutesUntilExpiry = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
      expect(minutesUntilExpiry).toBeCloseTo(30, 0);

      // Backdate the row past its own stored expiry and confirm verification
      // now fails with OTP_EXPIRED -- proving the check is enforced, not
      // just the stored value being correct.
      await db.emailVerification.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const result = await verifyEmail(db, { email: validInput.email, code });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('OTP_EXPIRED');
    });

    it('invalidates the code once otp.max_attempts is exhausted, even if the next guess is correct', async () => {
      await db.systemSetting.create({ data: { key: 'otp.max_attempts', value: 2 } });
      await registerCustomer(db, email, validInput, '10.0.1.4');
      const code = extractCode(email.sent[0]!);

      const wrong1 = await verifyEmail(db, { email: validInput.email, code: '111111' });
      expect(wrong1.ok).toBe(false);
      if (!wrong1.ok) expect(wrong1.error.code).toBe('OTP_INVALID');

      const wrong2 = await verifyEmail(db, { email: validInput.email, code: '222222' });
      expect(wrong2.ok).toBe(false);
      if (!wrong2.ok) expect(wrong2.error.code).toBe('OTP_INVALID');

      // Attempts are now exhausted (max_attempts = 2). The *correct* code
      // must now be refused too.
      const correctButTooLate = await verifyEmail(db, { email: validInput.email, code });
      expect(correctButTooLate.ok).toBe(false);
      if (!correctButTooLate.ok) expect(correctButTooLate.error.code).toBe('OTP_MAX_ATTEMPTS');
    });

    it('is rate-limited: repeatedly calling it for an email with no pending verification trips RATE_LIMITED', async () => {
      for (let i = 0; i < 5; i += 1) {
        const result = await verifyEmail(db, { email: 'nobody@example.com', code: '123456' }, `10.0.2.${i}`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('OTP_INVALID');
      }
      const sixth = await verifyEmail(db, { email: 'nobody@example.com', code: '123456' }, '10.0.2.99');
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('resendVerificationCode', () => {
    it('sends a fresh code and the old code no longer verifies', async () => {
      await registerCustomer(db, email, validInput, '10.0.3.1');
      const oldCode = extractCode(email.sent[0]!);

      await db.systemSetting.create({ data: { key: 'otp.resend_cooldown_seconds', value: 0 } });
      const resend = await resendVerificationCode(db, email, validInput.email, '10.0.3.1');
      expect(resend.ok).toBe(true);
      const newCode = extractCode(email.sent[1]!);
      expect(newCode).not.toBe(oldCode);

      const withOldCode = await verifyEmail(db, { email: validInput.email, code: oldCode });
      expect(withOldCode.ok).toBe(false);

      const withNewCode = await verifyEmail(db, { email: validInput.email, code: newCode });
      expect(withNewCode.ok).toBe(true);
    });

    it('refuses a resend before otp.resend_cooldown_seconds with OTP_RESEND_TOO_SOON', async () => {
      await registerCustomer(db, email, validInput, '10.0.3.2');
      const result = await resendVerificationCode(db, email, validInput.email, '10.0.3.2');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('OTP_RESEND_TOO_SOON');
    });

    it('refuses more than otp.max_resends_per_hour with RATE_LIMITED', async () => {
      await db.systemSetting.create({ data: { key: 'otp.resend_cooldown_seconds', value: 0 } });
      await db.systemSetting.create({ data: { key: 'otp.max_resends_per_hour', value: 2 } });
      await registerCustomer(db, email, validInput, '10.0.3.3'); // 1 code already sent

      const second = await resendVerificationCode(db, email, validInput.email, '10.0.3.3');
      expect(second.ok).toBe(true); // 2nd code: still within the cap of 2

      const third = await resendVerificationCode(db, email, validInput.email, '10.0.3.3');
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.error.code).toBe('RATE_LIMITED');
    });

    it('is rate-limited by the shared in-memory limiter regardless of the hourly cap', async () => {
      await registerCustomer(db, email, validInput, '10.0.4.1');
      // The default 60s cooldown rejects every one of these five resend
      // calls with OTP_RESEND_TOO_SOON (they all run within milliseconds),
      // but the generic limiter still counts each *call*, independent of
      // that per-call outcome -- see `resendVerificationCode`'s doc comment.
      for (let i = 0; i < 5; i += 1) {
        await resendVerificationCode(db, email, validInput.email, '10.0.4.1');
      }
      const sixthCallOverall = await resendVerificationCode(db, email, validInput.email, '10.0.4.1');
      expect(sixthCallOverall.ok).toBe(false);
      if (!sixthCallOverall.ok) expect(sixthCallOverall.error.code).toBe('RATE_LIMITED');
    });
  });
});
