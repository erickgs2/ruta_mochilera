import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { config as getConfig, setConfig } from './lib/config';
import { proxy } from './proxy';

describe('proxy (CORS preflight)', () => {
  afterEach(() => setConfig(undefined));

  it('answers a preflight from an allowed origin with 204 and the CORS headers, short-circuiting the CORS-less OPTIONS answer Next.js would give on its own', async () => {
    setConfig({ ...getConfig(), corsAllowedOrigins: ['capacitor://localhost'] });
    const request = new NextRequest('http://localhost/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'capacitor://localhost' },
    });

    const response = proxy(request);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('falls through (NextResponse.next) for a preflight from an origin outside the allowlist', async () => {
    setConfig({ ...getConfig(), corsAllowedOrigins: ['capacitor://localhost'] });
    const request = new NextRequest('http://localhost/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });

    const response = proxy(request);

    // NextResponse.next() carries this internal marker header -- its
    // presence is how we know this fell through rather than being answered.
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('falls through for a non-OPTIONS request regardless of Origin', async () => {
    setConfig({ ...getConfig(), corsAllowedOrigins: ['capacitor://localhost'] });
    const request = new NextRequest('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
    });

    const response = proxy(request);

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('falls through when the allowlist is empty, exactly matching today', async () => {
    setConfig({ ...getConfig(), corsAllowedOrigins: [] });
    const request = new NextRequest('http://localhost/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'capacitor://localhost' },
    });

    const response = proxy(request);

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
