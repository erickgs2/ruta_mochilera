import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { ok } from '@rm/shared-utils';
import { hashPassword, verifyPassword } from './password';
import { resetRateLimiterForTesting } from './rate-limiter';
import { requestPasswordReset, resetPassword } from './password-reset';

const db = withTestDb();

/** Deliberately not the production domain, so a hardcoded link cannot pass. */
const CLIENT_APP_URL = 'https://staging.example.test/app';

/**
 * A send latency chosen to be loud: the timing test's own tolerance below
 * is 50ms, so an accidentally-`await`ed send would blow past it by roughly
 * 4x, not get lost in noise. A fake that resolves instantly (as an earlier
 * version of this file's `FakeEmailProvider` did) would let a regression
 * that reintroduced `await emailProvider.send(...)` on the request path
 * pass this test anyway -- the test would never have exercised the one
 * thing it claims to prove. See this file's "fix report" entry in
 * `task-11-12-report.md` for the before/after proof.
 */
const SEND_LATENCY_MS = 200;

class FakeEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    await new Promise((resolve) => setTimeout(resolve, SEND_LATENCY_MS));
    this.sent.push(message);
    return ok({ providerMessageId: `fake-${this.sent.length}` });
  }
}

/**
 * `requestPasswordReset` deliberately never awaits `emailProvider.send(...)`
 * (see its doc comment) -- which means, with `FakeEmailProvider`'s now-real
 * `SEND_LATENCY_MS` delay, a test that wants to inspect `email.sent` must
 * wait for that detached send to actually land rather than assume it beat
 * the function's own (fast) return, the way the old zero-delay fake let
 * every call-site get away with. Polls rather than a single fixed sleep so
 * this does not itself become a flaky, timing-tuned test.
 */
async function waitForSentEmails(provider: FakeEmailProvider, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (provider.sent.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} email(s) to be sent (got ${provider.sent.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function extractToken(message: EmailMessage): string {
  const match = message.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match || !match[1]) throw new Error(`no reset token found in email body: ${message.text}`);
  return match[1];
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

async function seedSessionFor(userId: string, label: string) {
  return db.refreshToken.create({
    data: {
      userId,
      sessionId: randomUUID(),
      tokenHash: `hash-${label}`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
}

describe('requestPasswordReset / resetPassword', () => {
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

  describe('requestPasswordReset', () => {
    it('returns the identical ok(null) response whether or not the account exists', async () => {
      await seedCustomer();
      const existing = await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.0.1');
      const missing = await requestPasswordReset(db, 'nobody@example.com', email, CLIENT_APP_URL, '10.1.0.2');

      expect(existing).toEqual({ ok: true, value: null });
      expect(missing).toEqual({ ok: true, value: null });
    });

    it('takes comparable time for an existing and a nonexistent account', async () => {
      await seedCustomer();

      const startExisting = performance.now();
      await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.1.1');
      const existingMs = performance.now() - startExisting;

      const startMissing = performance.now();
      await requestPasswordReset(db, 'nobody@example.com', email, CLIENT_APP_URL, '10.1.1.2');
      const missingMs = performance.now() - startMissing;

      // Generous bound: the only architectural difference between the two
      // paths is one INSERT (see this module's doc comment on why the
      // actual email dispatch is never awaited, and therefore never on this
      // critical path for either branch) -- not a slow, network-bound
      // operation like login's argon2 asymmetry. 50ms comfortably covers
      // local Postgres jitter while still failing if a future change makes
      // one branch await something the other does not.
      expect(Math.abs(existingMs - missingMs)).toBeLessThan(50);
    });

    it('links to the reset screen under the configured CLIENT_APP_URL, not a hardcoded domain', async () => {
      await seedCustomer();
      await requestPasswordReset(db, 'traveler@example.com', email, `${CLIENT_APP_URL}/`, '10.1.7.1');
      await waitForSentEmails(email, 1);

      const token = extractToken(email.sent[0]!);
      const link = `${CLIENT_APP_URL}/reset-password?token=${token}`;
      expect(email.sent[0]!.text).toContain(link);
      expect(email.sent[0]!.html).toContain(link);
      expect(email.sent[0]!.text).not.toContain('rutamochilera.app');
    });

    it('stores only a hash of the token, never the plaintext, and the row is single-use', async () => {
      const user = await seedCustomer();
      await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.2.1');
      await waitForSentEmails(email, 1);
      const token = extractToken(email.sent[0]!);

      const row = await db.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.tokenHash).not.toBe(token);

      const first = await resetPassword(db, token, 'Brand-New-Pass-1');
      expect(first.ok).toBe(true);

      const second = await resetPassword(db, token, 'Another-Pass-2');
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('TOKEN_INVALID');
    });

    it('expires according to SystemSetting password_reset.ttl_minutes, not a hardcoded constant', async () => {
      await db.systemSetting.create({ data: { key: 'password_reset.ttl_minutes', value: 5 } });
      const user = await seedCustomer();
      await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.3.1');
      await waitForSentEmails(email, 1);
      const token = extractToken(email.sent[0]!);

      const row = await db.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
      const minutesUntilExpiry = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
      expect(minutesUntilExpiry).toBeCloseTo(5, 0);

      await db.passwordReset.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const result = await resetPassword(db, token, 'Brand-New-Pass-1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
    });

    it('is rate-limited by email+ip', async () => {
      await seedCustomer();
      for (let i = 0; i < 5; i += 1) {
        await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.4.1');
      }
      const sixth = await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.4.1');
      expect(sixth.ok).toBe(false);
      if (!sixth.ok) expect(sixth.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('resetPassword', () => {
    it('revokes every live session for the user', async () => {
      const user = await seedCustomer();
      await seedSessionFor(user.id, 'session-a');
      await seedSessionFor(user.id, 'session-b');

      await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.5.1');
      await waitForSentEmails(email, 1);
      const token = extractToken(email.sent[0]!);

      const result = await resetPassword(db, token, 'Brand-New-Pass-1');
      expect(result.ok).toBe(true);

      const liveSessions = await db.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
      expect(liveSessions).toBe(0);
    });

    it('actually changes the password: the old password no longer verifies, the new one does', async () => {
      const user = await seedCustomer();
      await requestPasswordReset(db, 'traveler@example.com', email, CLIENT_APP_URL, '10.1.6.1');
      await waitForSentEmails(email, 1);
      const token = extractToken(email.sent[0]!);

      await resetPassword(db, token, 'Brand-New-Pass-1');

      const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(await verifyPassword(updated.passwordHash!, 'Correct-Horse-1')).toBe(false);
      expect(await verifyPassword(updated.passwordHash!, 'Brand-New-Pass-1')).toBe(true);
    });

    it('rejects an unknown token with TOKEN_INVALID', async () => {
      const result = await resetPassword(db, 'not-a-real-token', 'Brand-New-Pass-1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('TOKEN_INVALID');
    });
  });
});
