import { describe, expect, it } from 'vitest';
import { clientPlatform, readRefreshToken, refreshTransport, sessionResponse } from './refresh-cookie';

describe('clientPlatform', () => {
  it('defaults to web when the header is absent', () => {
    expect(clientPlatform(new Request('http://localhost/x'))).toBe('web');
  });

  it('is native only for the exact literal "native"', () => {
    expect(clientPlatform(new Request('http://localhost/x', { headers: { 'x-client-platform': 'native' } }))).toBe(
      'native'
    );
  });

  it('fails closed to web for any other value -- an unrecognised header never changes the browser path', () => {
    expect(clientPlatform(new Request('http://localhost/x', { headers: { 'x-client-platform': 'ios' } }))).toBe(
      'web'
    );
  });
});

describe('refreshTransport', () => {
  it('is native for a caller with no cookie that says X-Client-Platform: native (the packaged app)', () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'x-client-platform': 'native', 'x-refresh-token': 'native-token' },
    });
    expect(refreshTransport(request)).toBe('native');
  });

  it('is web whenever the refresh cookie is present, even if the caller claims to be native (XSS cannot opt a browser session into the body)', () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { cookie: 'rm_refresh_token=cookie-token', 'x-client-platform': 'native' },
    });
    expect(refreshTransport(request)).toBe('web');
  });

  it('is web with neither cookie nor header', () => {
    expect(refreshTransport(new Request('http://localhost/x', { method: 'POST' }))).toBe('web');
  });
});

describe('readRefreshToken', () => {
  it('reads the cookie when present, ignoring the header', () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { cookie: 'rm_refresh_token=cookie-token', 'x-refresh-token': 'header-token' },
    });
    expect(readRefreshToken(request)).toBe('cookie-token');
  });

  it('falls back to the X-Refresh-Token header when there is no cookie (the native transport)', () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'x-refresh-token': 'native-token' },
    });
    expect(readRefreshToken(request)).toBe('native-token');
  });

  it("returns undefined with no cookie and no header at all (today's plain web refresh call)", () => {
    const request = new Request('http://localhost/x', { method: 'POST' });
    expect(readRefreshToken(request)).toBeUndefined();
  });

  it('returns undefined when the header is present but blank', () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'x-refresh-token': '   ' },
    });
    expect(readRefreshToken(request)).toBeUndefined();
  });
});

describe('sessionResponse', () => {
  const ok = {
    ok: true as const,
    value: {
      user: { id: 'u1' },
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSeconds: 900 },
    },
  };

  it('defaults to the web transport: sets the cookie, never includes refreshToken in the body', async () => {
    const response = sessionResponse(ok, 30);
    const body = await response.json();
    expect(body.tokens).not.toHaveProperty('refreshToken');
    expect(response.headers.get('set-cookie')).toContain('rm_refresh_token=refresh-1');
  });

  it('web platform, explicitly: identical to the default', async () => {
    const response = sessionResponse(ok, 30, 'web');
    const body = await response.json();
    expect(body.tokens).not.toHaveProperty('refreshToken');
    expect(response.headers.get('set-cookie')).toContain('rm_refresh_token=refresh-1');
  });

  it('native platform: includes refreshToken in the body, sets no cookie', async () => {
    const response = sessionResponse(ok, 30, 'native');
    const body = await response.json();
    expect(body.tokens.refreshToken).toBe('refresh-1');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('native platform on failure: still returns the problem response, still sets no cookie', async () => {
    const response = sessionResponse({ ok: false, error: { code: 'TOKEN_INVALID' } }, 30, 'native');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('web platform on failure: still clears the cookie, exactly as before', async () => {
    const response = sessionResponse({ ok: false, error: { code: 'TOKEN_INVALID' } }, 30, 'web');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('rm_refresh_token=;');
  });
});
