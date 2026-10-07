import { describe, expect, it, vi } from 'vitest';
import { ConsoleEmailProvider } from './console-email-provider';
import { runEmailContract } from '../testing/email-contract';

runEmailContract('console', async () => new ConsoleEmailProvider());

describe('ConsoleEmailProvider', () => {
  it('logs the recipient and subject but never the body by default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new ConsoleEmailProvider();

    const result = await provider.send({
      to: 'traveler@example.com',
      subject: 'Your six-digit code',
      html: '<p>123456</p>',
      text: '123456',
    });

    expect(result.ok).toBe(true);
    const loggedOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedOutput).toContain('traveler@example.com');
    expect(loggedOutput).toContain('Your six-digit code');
    expect(loggedOutput).not.toContain('123456');

    logSpy.mockRestore();
  });

  it('prints the html and text bodies only when verbose is explicitly enabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new ConsoleEmailProvider({ verbose: true });

    await provider.send({
      to: 'traveler@example.com',
      subject: 'Your six-digit code',
      html: '<p>123456</p>',
      text: '123456',
    });

    const loggedOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedOutput).toContain('123456');

    logSpy.mockRestore();
  });

  it('generates a different provider message id for each send', async () => {
    const provider = new ConsoleEmailProvider();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const first = await provider.send({ to: 'a@example.com', subject: 's', html: '<p>h</p>', text: 't' });
    const second = await provider.send({ to: 'b@example.com', subject: 's', html: '<p>h</p>', text: 't' });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.providerMessageId).not.toBe(second.value.providerMessageId);
    }

    vi.restoreAllMocks();
  });
});
