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
 *
 * Coverage note for the next reader: as of Task 6 this contract is run
 * only against `ConsoleEmailProvider` (see `console-email-provider.spec.ts`),
 * which exercises all three modes below, including the simulated
 * provider-rejection one via `PROVIDER_REJECTED_TEST_ADDRESS`.
 * `ResendEmailProvider` has no account or API key in this environment and
 * does not honor that sentinel (a real Resend request to it would likely
 * just be accepted, with any bounce happening asynchronously) — it is
 * typechecked only. Do not read a green run of this suite as proof that
 * the Resend adapter's error mapping has ever actually run.
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

    it('returns a VALIDATION_FAILED Result, never a thrown exception, for a malformed recipient address', async () => {
      // This is the caller's fault: a well-formed send never reaches the
      // provider with an address like this, so it maps to the 422 code.
      await expect(
        provider.send({ to: 'not-an-email-address', subject: 'Hi', html: '<p>hi</p>', text: 'hi' })
      ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it('returns an EMAIL_PROVIDER_ERROR Result, never a thrown exception, when the provider itself rejects the send', async () => {
      // This is the provider's (or the network's) fault, not the caller's,
      // so it maps to the 502 code instead of VALIDATION_FAILED.
      await expect(
        provider.send({
          to: PROVIDER_REJECTED_TEST_ADDRESS,
          subject: 'Hi',
          html: '<p>hi</p>',
          text: 'hi',
        })
      ).resolves.toMatchObject({ ok: false, error: { code: 'EMAIL_PROVIDER_ERROR' } });
    });
  });
}
