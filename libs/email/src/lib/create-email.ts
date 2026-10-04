import type { AppEnv } from '@rm/shared-utils';
import { ConsoleEmailProvider } from './console-email-provider';
import type { EmailProvider } from './email-provider';
import { ResendEmailProvider } from './resend-email-provider';

/** Reads a provider-specific env value, failing fast with a clear message if it is missing. */
function requireEnvValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable for email: ${name}`);
  }
  return value;
}

/** Chooses the implementation from the environment. Nothing else in the app branches on the provider. */
export function createEmail(env: AppEnv): EmailProvider {
  if (env.nodeEnv === 'development' || env.nodeEnv === 'test') {
    return new ConsoleEmailProvider();
  }
  const apiKey = requireEnvValue(env.resendApiKey, 'RESEND_API_KEY');
  const fromAddress = requireEnvValue(env.resendFromAddress, 'RESEND_FROM_ADDRESS');
  return new ResendEmailProvider(apiKey, fromAddress);
}
