import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient } from '@rm/db';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { ok } from '@rm/shared-utils';
import { hashOtpCode } from './otp';
import { resetRateLimiterForTesting } from './rate-limiter';
import { registerCustomer, resendVerificationCode, verifyEmail, type RegisterCustomerInput } from './customer-registration';

const db = withTestDb();

/** Gives the other transaction time to reach the row lock before this one commits. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus the handle that settles it, used to pin down an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/**
 * Same shape as `clientPausingBeforeInsert` in
 * `reservation-service.spec.ts` / `clientPausingAt` in
 * `payment-service.spec.ts`: a proxy over the injected client that parks
 * the first `registerCustomer` call's `tx.user.create` at a chosen point,
 * so a second concurrent call for the same email can run its own full
 * read-decide-insert sequence into that open window. A plain `Promise.all`
 * of two attempts is not enough on this machine -- the first transaction
 * commits before the second even reads -- so this is what actually forces
 * the interleaving the unique-violation fallback in `registerCustomer` is
 * meant to survive.
 */
function clientPausingBeforeUserInsert(db: Db, pause: () => Promise<void>): Db {
  const forward = (target: object, property: string | symbol) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };

  const pausingTransactionClient = (tx: DbTransactionClient): DbTransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        if (property !== 'user') return forward(target, property);
        const users = Reflect.get(target, property) as DbTransactionClient['user'];
        return new Proxy(users, {
          get(delegate, operation) {
            if (operation !== 'create') return forward(delegate, operation);
            return async (...args: Parameters<DbTransactionClient['user']['create']>) => {
              await pause();
              return delegate.create(...args);
            };
          },
        });
      },
    }) as DbTransactionClient;

  return new Proxy(db, {
    get(target, property) {
      if (property !== '$transaction') return forward(target, property);
      return (run: (tx: DbTransactionClient) => Promise<unknown>) =>
        target.$transaction((tx) => run(pausingTransactionClient(tx)));
    },
  }) as Db;
}

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

    describe('birth date', () => {
      afterEach(() => vi.useRealTimers());

      async function setOrganizationTimeZone(value: string): Promise<void> {
        await db.systemSetting.upsert({
          where: { key: 'organization.timezone' },
          create: { key: 'organization.timezone', value },
          update: { value },
        });
      }

      async function expectRejected(birthDate: string): Promise<void> {
        const result = await registerCustomer(db, email, { ...validInput, birthDate: new Date(birthDate) }, '10.0.0.30');
        expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'birthDate' } } });
        expect(await db.user.count()).toBe(0);
        expect(email.sent).toHaveLength(0);
      }

      it('rejects a date in the future', async () => {
        await expectRejected('2999-01-01');
      });

      it('rejects a date before 1900', async () => {
        await expectRejected('1899-12-31');
      });

      it('accepts 1900-01-01 and today', async () => {
        await setOrganizationTimeZone('America/Mexico_City');
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-10T15:00:00Z') });

        expect((await registerCustomer(db, email, { ...validInput, birthDate: new Date('1900-01-01') }, '10.0.0.31')).ok).toBe(true);
        expect(
          (await registerCustomer(db, email, { ...validInput, email: 'today@example.com', birthDate: new Date('2027-03-10') }, '10.0.0.32')).ok
        ).toBe(true);
      });

      it("takes 'today' in the organization time zone: behind UTC, the UTC date is still tomorrow", async () => {
        await setOrganizationTimeZone('America/Mexico_City');
        // 21:00 on 9 March in Mexico City, already 10 March in UTC.
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-10T03:00:00Z') });

        await expectRejected('2027-03-10');
        expect((await registerCustomer(db, email, { ...validInput, birthDate: new Date('2027-03-09') }, '10.0.0.33')).ok).toBe(true);
      });

      it("takes 'today' in the organization time zone: ahead of UTC, the UTC date is still yesterday", async () => {
        await setOrganizationTimeZone('Pacific/Auckland');
        // 09:00 on 10 March in Auckland, still 9 March in UTC.
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-09T20:00:00Z') });

        expect((await registerCustomer(db, email, { ...validInput, birthDate: new Date('2027-03-10') }, '10.0.0.34')).ok).toBe(true);
      });
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

    it('closes the forced race on a brand-new email: the loser falls back to the enumeration-safe response instead of throwing', async () => {
      const raceEmail = 'racer@example.com';

      const firstHasReachedInsert = deferred();
      const firstMayInsert = deferred();

      const pausing = clientPausingBeforeUserInsert(db, async () => {
        firstHasReachedInsert.resolve();
        await firstMayInsert.promise;
      });

      // The first call parks inside its own transaction, right before the
      // INSERT, with its pre-check already having seen no existing row.
      const first = registerCustomer(pausing, email, { ...validInput, email: raceEmail }, '10.0.7.1');

      // The second call only starts once the first has reached that park
      // point, and runs its own full read-decide-insert sequence into the
      // open window on a plain (non-paused) client -- it wins the race and
      // commits first.
      const second = (async () => {
        await firstHasReachedInsert.promise;
        return registerCustomer(db, email, { ...validInput, email: raceEmail }, '10.0.7.2');
      })();

      // Long enough for the second attempt to reach and commit its INSERT.
      // Not load-bearing precision -- too short and the second attempt
      // simply has not committed yet when the first resumes, which would
      // make the first the race's accidental winner instead of its loser;
      // the assertions below only care that exactly one row and one
      // six-digit-code email exist afterward, not which call produced them.
      await settle(200);
      firstMayInsert.resolve();

      const results = await Promise.all([first, second]);

      // Both calls return the same enumeration-safe ok(null), win or lose.
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);

      // Exactly one user row exists despite two concurrent attempts for the
      // same brand-new email.
      const users = await db.user.findMany({ where: { email: raceEmail } });
      expect(users).toHaveLength(1);

      // Exactly one real verification code went out (from whichever call
      // actually won the insert); the loser sent the code-free "someone
      // tried to register" notice instead of crashing with an unhandled
      // unique-constraint exception.
      expect(email.sent).toHaveLength(2);
      const codeEmails = email.sent.filter((message) => /\d{6}/.test(message.text));
      expect(codeEmails).toHaveLength(1);
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

    it('does not let an unauthenticated caller distinguish a real pending registration from an unknown email (account-status oracle)', async () => {
      // Real population: a customer with a pending, unverified code.
      await registerCustomer(db, email, validInput, '10.0.9.1');
      // Fake population: no account at all.

      // At the seeded default (otp.max_attempts = 5, and the generic
      // limiter's own fixed cap of 5), max_attempts + 1 = 6 wrong codes
      // against *either* population must land on the exact same terminal
      // code. Different IPs per call isolate the email-keyed bucket, the
      // same way the login rate-limit tests do.
      const realCodes: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await verifyEmail(db, { email: validInput.email, code: '000000' }, `10.0.9.${10 + i}`);
        realCodes.push(result.ok ? 'OK' : result.error.code);
      }

      const fakeCodes: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await verifyEmail(db, { email: 'nobody-else@example.com', code: '000000' }, `10.0.9.${20 + i}`);
        fakeCodes.push(result.ok ? 'OK' : result.error.code);
      }

      // Before the fix, the real population's 6th call returned
      // OTP_MAX_ATTEMPTS (only reachable when a pending row exists) while
      // the fake population's 6th call returned RATE_LIMITED -- an
      // account-status oracle. Both must now be RATE_LIMITED.
      expect(realCodes[5]).toBe('RATE_LIMITED');
      expect(fakeCodes[5]).toBe('RATE_LIMITED');
      expect(realCodes[5]).toBe(fakeCodes[5]);
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

    it('allows exactly otp.max_resends_per_hour actual resends, not one fewer for having silently counted the original registration code', async () => {
      await db.systemSetting.create({ data: { key: 'otp.resend_cooldown_seconds', value: 0 } });
      await db.systemSetting.create({ data: { key: 'otp.max_resends_per_hour', value: 2 } });
      await registerCustomer(db, email, validInput, '10.0.3.3'); // the original code -- never itself a "resend"

      const firstResend = await resendVerificationCode(db, email, validInput.email, '10.0.3.3');
      expect(firstResend.ok).toBe(true); // resend 1 of 2

      const secondResend = await resendVerificationCode(db, email, validInput.email, '10.0.3.3');
      expect(secondResend.ok).toBe(true); // resend 2 of 2 -- the setting's name promises two, so two must succeed

      const thirdResend = await resendVerificationCode(db, email, validInput.email, '10.0.3.3');
      expect(thirdResend.ok).toBe(false);
      if (!thirdResend.ok) expect(thirdResend.error.code).toBe('RATE_LIMITED');
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
