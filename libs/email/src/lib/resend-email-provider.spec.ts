import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendEmailProvider } from './resend-email-provider';

describe('ResendEmailProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends attachments inline as base64 with their name and type', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResendEmailProvider('re_key', 'Ruta Mochilera <hola@rutamochilera.test>');

    const result = await provider.send({
      to: 'traveler@example.com',
      subject: 'Tu recibo',
      html: '<p>Recibo</p>',
      text: 'Recibo',
      attachments: [{ filename: 'RM-2027-000001.pdf', contentType: 'application/pdf', content: new Uint8Array([37, 80, 68, 70]) }],
    });

    expect(result).toEqual({ ok: true, value: { providerMessageId: 'msg_1' } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).attachments).toEqual([
      { filename: 'RM-2027-000001.pdf', content_type: 'application/pdf', content: 'JVBERg==' },
    ]);
  });

  it('sends no attachments field when there are none', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResendEmailProvider('re_key', 'hola@rutamochilera.test');

    await provider.send({ to: 'traveler@example.com', subject: 's', html: 'h', text: 't' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('attachments');
  });

  it('maps a rejected request to EMAIL_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'bad' }), { status: 422 })));
    const provider = new ResendEmailProvider('re_key', 'hola@rutamochilera.test');

    const result = await provider.send({ to: 'traveler@example.com', subject: 's', html: 'h', text: 't' });

    expect(result).toMatchObject({ ok: false, error: { code: 'EMAIL_PROVIDER_ERROR', details: { status: 422 } } });
  });
});
