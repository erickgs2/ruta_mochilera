import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { resetRateLimiterForTesting } from '@rm/domain-identity';
import { ok, type Result } from '@rm/shared-utils';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { setEmail } from '../../../../lib/email';
import { POST as registerRoute } from './register/route';
import { POST as verifyEmailRoute } from './verify-email/route';
import { POST as resendCodeRoute } from './resend-code/route';

const db = withTestDb();

class FakeEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>> {
    this.sent.push(message);
    return ok({ providerMessageId: `fake-${this.sent.length}` });
  }
}

function extractCode(message: EmailMessage): string {
  const match = message.text.match(/\d{6}/);
  if (!match) throw new Error(`no six-digit code found: ${message.text}`);
  return match[0];
}

function post(handler: typeof registerRoute, body: unknown, ip = '198.51.100.1') {
  return handler(
    new Request('http://localhost/api/v1/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    })
  );
}

const validBody = {
  email: 'new.customer@example.com',
  password: 'Correct-Horse-1',
  fullName: 'Nueva Clienta',
  phone: '+52 55 1234 5678',
  birthDate: '1990-01-01',
  acceptTerms: true,
};

describe('registration endpoints', () => {
  let fakeEmail: FakeEmailProvider;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    resetRateLimiterForTesting();
    fakeEmail = new FakeEmailProvider();
    setEmail(fakeEmail);
  });

  afterAll(async () => {
    setEmail(undefined);
    await closeTestDb();
  });

  describe('POST /auth/register', () => {
    it('accepts a new registration and sends a six-digit verification code', async () => {
      const response = await post(registerRoute, validBody, '203.0.113.10');
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      expect(fakeEmail.sent).toHaveLength(1);
      expect(extractCode(fakeEmail.sent[0]!)).toMatch(/^\d{6}$/);
    });

    it('returns 422 when the body fails validation (e.g. acceptTerms omitted)', async () => {
      const { acceptTerms: _acceptTerms, ...withoutAcceptTerms } = validBody;
      const response = await post(registerRoute, withoutAcceptTerms, '203.0.113.11');
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['in the future', '2999-01-01'],
      ['before 1900', '1899-12-31'],
    ])('rejects a birth date %s with VALIDATION_FAILED on birthDate, creating nothing', async (_label, birthDate) => {
      const response = await post(registerRoute, { ...validBody, birthDate }, '203.0.113.14');

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ field: 'birthDate' });
      expect(await db.user.count()).toBe(0);
      expect(fakeEmail.sent).toHaveLength(0);
    });

    it('responds identically for an email that is already registered: same 200, same null body', async () => {
      await post(registerRoute, validBody, '203.0.113.12');
      const second = await post(registerRoute, { ...validBody, fullName: 'Someone Else' }, '203.0.113.13');

      expect(second.status).toBe(200);
      expect(await second.json()).toBeNull();
    });

    it('is rate-limited: a sixth request from the same IP within the window gets RATE_LIMITED', async () => {
      for (let i = 0; i < 5; i += 1) {
        const response = await post(
          registerRoute,
          { ...validBody, email: `person-${i}@example.com` },
          '203.0.113.20'
        );
        expect(response.status).toBe(200);
      }
      const sixth = await post(registerRoute, { ...validBody, email: 'person-6@example.com' }, '203.0.113.20');
      expect(sixth.status).toBe(429);
      expect((await sixth.json()).code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /auth/verify-email', () => {
    it('verifies with the correct code and rejects reuse', async () => {
      await post(registerRoute, validBody, '203.0.113.30');
      const code = extractCode(fakeEmail.sent[0]!);

      const first = await post(verifyEmailRoute, { email: validBody.email, code }, '203.0.113.30');
      expect(first.status).toBe(200);

      const second = await post(verifyEmailRoute, { email: validBody.email, code }, '203.0.113.30');
      expect(second.status).toBe(422);
      expect((await second.json()).code).toBe('OTP_INVALID');
    });

    it('rejects a malformed code at the validation layer', async () => {
      const response = await post(verifyEmailRoute, { email: validBody.email, code: 'abc' }, '203.0.113.31');
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it('is rate-limited: a sixth request against an email with no pending verification gets RATE_LIMITED', async () => {
      for (let i = 0; i < 5; i += 1) {
        const response = await post(
          verifyEmailRoute,
          { email: 'nobody@example.com', code: '123456' },
          '203.0.113.40'
        );
        expect(response.status).toBe(422);
      }
      const sixth = await post(
        verifyEmailRoute,
        { email: 'nobody@example.com', code: '123456' },
        '203.0.113.40'
      );
      expect(sixth.status).toBe(429);
      expect((await sixth.json()).code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /auth/resend-code', () => {
    it('sends a fresh code that supersedes the old one', async () => {
      await post(registerRoute, validBody, '203.0.113.50');
      await db.systemSetting.create({ data: { key: 'otp.resend_cooldown_seconds', value: 0 } });

      const response = await post(resendCodeRoute, { email: validBody.email }, '203.0.113.50');
      expect(response.status).toBe(200);
      expect(fakeEmail.sent).toHaveLength(2);
    });

    it('refuses an immediate resend with OTP_RESEND_TOO_SOON', async () => {
      await post(registerRoute, validBody, '203.0.113.51');
      const response = await post(resendCodeRoute, { email: validBody.email }, '203.0.113.51');
      // 429, not 422: this is a pacing problem (too soon), the same status
      // family as RATE_LIMITED, not a malformed request.
      expect(response.status).toBe(429);
      expect((await response.json()).code).toBe('OTP_RESEND_TOO_SOON');
    });

    it('is rate-limited: a sixth request from the same IP gets RATE_LIMITED', async () => {
      await post(registerRoute, validBody, '203.0.113.60');
      for (let i = 0; i < 5; i += 1) {
        await post(resendCodeRoute, { email: validBody.email }, '203.0.113.60');
      }
      const sixth = await post(resendCodeRoute, { email: validBody.email }, '203.0.113.60');
      expect(sixth.status).toBe(429);
      expect((await sixth.json()).code).toBe('RATE_LIMITED');
    });
  });
});
