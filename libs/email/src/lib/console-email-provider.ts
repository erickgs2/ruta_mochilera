import { randomUUID } from 'node:crypto';
import { fail, ok, type Result } from '@rm/shared-utils';
import {
  isValidEmailAddress,
  PROVIDER_REJECTED_TEST_ADDRESS,
  type EmailMessage,
  type EmailProvider,
} from './email-provider';

export interface ConsoleEmailProviderOptions {
  /**
   * Also print the `html`/`text` bodies. Off by default: Task 11 sends
   * six-digit email-verification codes through this port, and a console
   * adapter that echoes bodies by default would spill every OTP into the
   * development log. Opt in explicitly when a body genuinely needs to be
   * seen locally.
   */
  verbose?: boolean;
}

/**
 * Prints the message to the console and returns a synthetic id. Used in
 * development and in tests — the reason the rest of the domain can be
 * exercised without ever talking to Resend.
 */
export class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly options: ConsoleEmailProviderOptions = {}) {}

  async send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>> {
    if (!isValidEmailAddress(message.to)) {
      return fail('VALIDATION_FAILED', { field: 'to' });
    }
    if (message.to === PROVIDER_REJECTED_TEST_ADDRESS) {
      return fail('EMAIL_PROVIDER_ERROR', { reason: 'simulated_provider_rejection' });
    }

    console.log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    if (this.options.verbose) {
      console.log(`[email] html=${message.html}`);
      console.log(`[email] text=${message.text}`);
    }

    return ok({ providerMessageId: `console-${randomUUID()}` });
  }
}
