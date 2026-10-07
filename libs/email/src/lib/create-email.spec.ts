import type { AppEnv } from '@rm/shared-utils';
import { describe, expect, it, vi } from 'vitest';
import { createEmail } from './create-email';

const baseEnv: AppEnv = {
  nodeEnv: 'development',
  databaseUrl: 'postgresql://rm:rm@localhost:5432/rm_dev',
  jwtSecret: 'x'.repeat(32),
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  appBaseUrl: 'http://localhost:3000',
  clientAppUrl: 'http://localhost:4201',
  storageDriver: 'local',
  storageLocalRoot: './storage',
  emailVerboseLogging: false,
  corsAllowedOrigins: [],
};

/**
 * Collects every `console.log` call made during `run`, then restores it.
 * The output must be read before `mockRestore()`, which clears `mock.calls`
 * as part of restoring the original implementation.
 */
async function captureConsoleLog(run: () => Promise<void>): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await run();
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  } finally {
    logSpy.mockRestore();
  }
}

describe('createEmail', () => {
  it('builds a console provider in development that stays quiet by default', async () => {
    const provider = createEmail(baseEnv);

    const loggedOutput = await captureConsoleLog(async () => {
      await provider.send({ to: 'traveler@example.com', subject: 'Code', html: '<p>123456</p>', text: '123456' });
    });

    expect(loggedOutput).not.toContain('123456');
  });

  it('threads AppEnv.emailVerboseLogging through to the console provider', async () => {
    const provider = createEmail({ ...baseEnv, emailVerboseLogging: true });

    const loggedOutput = await captureConsoleLog(async () => {
      await provider.send({ to: 'traveler@example.com', subject: 'Code', html: '<p>123456</p>', text: '123456' });
    });

    expect(loggedOutput).toContain('123456');
  });
});
