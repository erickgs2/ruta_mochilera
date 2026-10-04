import type { Result } from '@rm/shared-utils';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal recipient shape check shared by every EmailProvider
 * implementation, so a malformed address is rejected the same way
 * everywhere instead of drifting apart the way the Phase 1 storage
 * contract let two implementations drift on an operation it never
 * exercised.
 */
export function isValidEmailAddress(address: string): boolean {
  return EMAIL_PATTERN.test(address);
}

/**
 * Reserved recipient that signals a simulated provider-level rejection
 * instead of a real send — analogous to the "mailbox simulator" addresses
 * real providers (e.g. Amazon SES) expose for exactly this purpose. Exists
 * so the shared contract test can prove a provider failure comes back as a
 * `Result` and never as a thrown exception, without needing a live failure
 * from Resend. `ConsoleEmailProvider` honors it directly; it is never a
 * real recipient.
 */
export const PROVIDER_REJECTED_TEST_ADDRESS = 'provider-rejected@email.test';
