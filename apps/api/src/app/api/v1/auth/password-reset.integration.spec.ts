import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword, resetRateLimiterForTesting } from '@rm/domain-identity';
import { ok, type Result } from '@rm/shared-utils';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { config, setConfig } from '../../../../lib/config';
import { setEmail } from '../../../../lib/email';
import { POST as loginRoute } from './login/route';
import { POST as forgotPasswordRoute } from './forgot-password/route';
import { POST as resetPasswordRoute } from './reset-password/route';
import { POST as refreshRoute } from './refresh/route';

const db = withTestDb();

class FakeEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>> {
    this.sent.push(message);
    return ok({ providerMessageId: `fake-${this.sent.length}` });
  }
}

function extractToken(message: EmailMessage): string {
  const match = message.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match || !match[1]) throw new Error(`no reset token found: ${message.text}`);
  return match[1];
}

function post(handler: typeof forgotPasswordRoute, body: unknown, ip = '198.51.100.1') {
  return handler(
    new Request('http://localhost/api/v1/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    })
  );
}

function cookiePairFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('response carried no Set-Cookie header');
  const pair = setCookie.split(';')[0];
  if (!pair) throw new Error('malformed Set-Cookie header');
  return pair;
}

async function seedCustomer(email = 'traveler@example.com', password = 'Correct-Horse-1') {
  return db.user.create({
    data: {
      email,
      type: 'CUSTOMER',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: {
          fullName: 'Traveler',
          phone: '+52 55 0000 0000',
          birthDate: new Date('1990-01-01'),
          origin: 'SELF_SIGNUP',
        },
      },
    },
  });
}

describe('password reset endpoints', () => {
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

  describe('POST /auth/forgot-password', () => {
    it('responds 200 with a null body whether or not the account exists', async () => {
      await seedCustomer();
      const existing = await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.70');
      const missing = await post(forgotPasswordRoute, { email: 'nobody@example.com' }, '203.0.113.71');

      expect(existing.status).toBe(200);
      expect(await existing.json()).toBeNull();
      expect(missing.status).toBe(200);
      expect(await missing.json()).toBeNull();
    });

    it("links to the client app's reset screen under CLIENT_APP_URL, path prefix included, not the API origin", async () => {
      await seedCustomer();
      setConfig({ ...config(), appBaseUrl: 'https://api.example.test', clientAppUrl: 'https://www.example.test/app' });
      try {
        const response = await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.73');
        expect(response.status).toBe(200);
        await vi.waitFor(() => expect(fakeEmail.sent).toHaveLength(1));

        const token = extractToken(fakeEmail.sent[0]!);
        expect(fakeEmail.sent[0]!.text).toContain(`https://www.example.test/app/reset-password?token=${token}`);
        expect(fakeEmail.sent[0]!.text).not.toContain('api.example.test');
      } finally {
        setConfig(undefined);
      }
    });

    it('returns 422 on a malformed email', async () => {
      const response = await post(forgotPasswordRoute, { email: 'not-an-email' }, '203.0.113.72');
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it('is rate-limited: a sixth request from the same IP gets RATE_LIMITED', async () => {
      await seedCustomer();
      for (let i = 0; i < 5; i += 1) {
        const response = await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.80');
        expect(response.status).toBe(200);
      }
      const sixth = await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.80');
      expect(sixth.status).toBe(429);
      expect((await sixth.json()).code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /auth/reset-password', () => {
    it('changes the password, logs the old one out, and revokes every live refresh session', async () => {
      await seedCustomer();

      // Establish a live session the way a browser would, before the reset.
      const login = await post(loginRoute, { email: 'traveler@example.com', password: 'Correct-Horse-1' }, '203.0.113.90');
      expect(login.status).toBe(200);
      const sessionCookie = cookiePairFrom(login);

      await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.90');
      const token = extractToken(fakeEmail.sent[0]!);

      const reset = await resetPasswordRoute(
        new Request('http://localhost/api/v1/auth/reset-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, newPassword: 'Brand-New-Pass-1' }),
        })
      );
      expect(reset.status).toBe(200);
      expect(await reset.json()).toBeNull();

      // The pre-reset session's refresh cookie no longer works.
      const refreshAfterReset = await refreshRoute(
        new Request('http://localhost/api/v1/auth/refresh', { method: 'POST', headers: { cookie: sessionCookie } })
      );
      expect(refreshAfterReset.status).toBe(401);

      // The old password no longer logs in; the new one does.
      const loginOldPassword = await post(loginRoute, { email: 'traveler@example.com', password: 'Correct-Horse-1' }, '203.0.113.91');
      expect(loginOldPassword.status).toBe(401);

      const loginNewPassword = await post(loginRoute, { email: 'traveler@example.com', password: 'Brand-New-Pass-1' }, '203.0.113.92');
      expect(loginNewPassword.status).toBe(200);
    });

    it('rejects an unknown token with 401 TOKEN_INVALID', async () => {
      const response = await resetPasswordRoute(
        new Request('http://localhost/api/v1/auth/reset-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'not-a-real-token', newPassword: 'Brand-New-Pass-1' }),
        })
      );
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('rejects a reused token on the second attempt', async () => {
      await seedCustomer();
      await post(forgotPasswordRoute, { email: 'traveler@example.com' }, '203.0.113.95');
      const token = extractToken(fakeEmail.sent[0]!);

      const build = () =>
        resetPasswordRoute(
          new Request('http://localhost/api/v1/auth/reset-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, newPassword: 'Brand-New-Pass-1' }),
          })
        );

      expect((await build()).status).toBe(200);
      const second = await build();
      expect(second.status).toBe(401);
      expect((await second.json()).code).toBe('TOKEN_INVALID');
    });
  });
});
