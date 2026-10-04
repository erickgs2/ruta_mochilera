import { fail, ok, type Result } from '@rm/shared-utils';
import { isValidEmailAddress, type EmailMessage, type EmailProvider } from './email-provider';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface ResendSuccessResponse {
  id: string;
}

interface ResendErrorResponse {
  message?: string;
  name?: string;
}

/**
 * Talks to the Resend HTTP API directly (no SDK dependency). Used in qa and
 * production. There is no Resend account or API key in development, so
 * this class is typechecked but never executed here — see the library
 * README and Task 6 report for details.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string
  ) {}

  async send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>> {
    if (!isValidEmailAddress(message.to)) {
      return fail('VALIDATION_FAILED', { field: 'to' });
    }

    try {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as ResendErrorResponse;
        return fail('VALIDATION_FAILED', { status: response.status, message: error.message ?? error.name });
      }

      const body = (await response.json()) as ResendSuccessResponse;
      return ok({ providerMessageId: body.id });
    } catch (error) {
      // Network failure, timeout, DNS, etc. A message that doesn't go out
      // must never take down the transaction that originated it.
      return fail('VALIDATION_FAILED', {
        reason: 'network_error',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}
