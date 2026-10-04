import { beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_REJECTED_TEST_ADDRESS, type EmailProvider } from '../lib/email-provider';

/**
 * Behaviour every EmailProvider must satisfy. Run it against each
 * implementation so local (console) and Resend can never drift apart.
 *
 * There is only one operation, `send`, so this exercises its three modes
 * directly rather than spreading coverage thin across unrelated
 * operations the way the Phase 1 storage contract first did — that
 * contract exercised only one of five operations and missed a divergence
 * in another.
 */
export function runEmailContract(name: string, factory: () => Promise<EmailProvider>): void {
  describe(`${name} email contract`, () => {
    let provider: EmailProvider;

    beforeEach(async () => {
      provider = await factory();
    });

    it('sends a well-formed message and returns a provider message id', async () => {
      const result = await provider.send({
        to: 'traveler@example.com',
        subject: 'Your reservation is confirmed',
        html: '<p>Confirmed</p>',
        text: 'Confirmed',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.providerMessageId).toBe('string');
        expect(result.value.providerMessageId.length).toBeGreaterThan(0);
      }
    });

    it('returns a failed Result, never a thrown exception, for a malformed recipient address', async () => {
      await expect(
        provider.send({ to: 'not-an-email-address', subject: 'Hi', html: '<p>hi</p>', text: 'hi' })
      ).resolves.toMatchObject({ ok: false });
    });

    it('returns a failed Result, never a thrown exception, when the provider itself rejects the send', async () => {
      await expect(
        provider.send({
          to: PROVIDER_REJECTED_TEST_ADDRESS,
          subject: 'Hi',
          html: '<p>hi</p>',
          text: 'hi',
        })
      ).resolves.toMatchObject({ ok: false });
    });
  });
}
