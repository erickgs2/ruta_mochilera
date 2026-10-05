import { describe, expect, it } from 'vitest';
import { applyCorsHeaders, corsPreflightResponse, isAllowedOrigin } from './cors';

const ALLOWED = ['capacitor://localhost', 'https://localhost'];

describe('isAllowedOrigin', () => {
  it('matches an origin present in the allowlist exactly', () => {
    expect(isAllowedOrigin('capacitor://localhost', ALLOWED)).toBe(true);
  });

  it('rejects an origin absent from the allowlist', () => {
    expect(isAllowedOrigin('https://evil.example', ALLOWED)).toBe(false);
  });

  it('rejects null (no Origin header at all)', () => {
    expect(isAllowedOrigin(null, ALLOWED)).toBe(false);
  });

  it('rejects everything when the allowlist is empty', () => {
    expect(isAllowedOrigin('capacitor://localhost', [])).toBe(false);
  });

  it('never matches on a wildcard entry -- the allowlist holds exact origins only', () => {
    expect(isAllowedOrigin('https://anything.example', ['*'])).toBe(false);
  });
});

describe('applyCorsHeaders', () => {
  it('adds no headers at all when there is no Origin header -- the same-origin admin/web path must not change', () => {
    const request = new Request('http://localhost/api/v1/trips');
    const response = new Response(null, { status: 200 });
    const result = applyCorsHeaders(response, request, ALLOWED);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
    expect(result.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('adds no headers when the Origin does not match the allowlist', () => {
    const request = new Request('http://localhost/api/v1/trips', { headers: { origin: 'https://evil.example' } });
    const response = new Response(null, { status: 200 });
    const result = applyCorsHeaders(response, request, ALLOWED);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes the exact matching origin, allows credentials, and varies on Origin', () => {
    const request = new Request('http://localhost/api/v1/trips', { headers: { origin: 'capacitor://localhost' } });
    const response = new Response(null, { status: 200 });
    const result = applyCorsHeaders(response, request, ALLOWED);
    expect(result.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(result.headers.get('access-control-allow-credentials')).toBe('true');
    expect(result.headers.get('vary')).toBe('Origin');
  });

  it('adds Origin to an existing Vary header instead of replacing it', () => {
    const request = new Request('http://localhost/api/v1/trips', { headers: { origin: 'capacitor://localhost' } });
    const response = new Response(null, { status: 200, headers: { vary: 'Accept-Encoding' } });
    const result = applyCorsHeaders(response, request, ALLOWED);
    expect(result.headers.get('vary')).toBe('Accept-Encoding, Origin');
  });

  it('preserves the original response status and body headers -- this never replaces the response, only adds to it', () => {
    const request = new Request('http://localhost/api/v1/auth/login', { headers: { origin: 'capacitor://localhost' } });
    const response = Response.json({ code: 'TOKEN_INVALID' }, { status: 401 });
    const result = applyCorsHeaders(response, request, ALLOWED);
    expect(result.status).toBe(401);
    expect(result.headers.get('content-type')).toContain('application/json');
  });

  it('never sets Access-Control-Allow-Origin to a wildcard, even if the allowlist somehow contained one', () => {
    const request = new Request('http://localhost/api/v1/trips', { headers: { origin: 'https://evil.example' } });
    const response = new Response(null, { status: 200 });
    const result = applyCorsHeaders(response, request, ['*']);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('corsPreflightResponse', () => {
  it('returns null for a non-OPTIONS request', () => {
    const request = new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
    });
    expect(corsPreflightResponse(request, ALLOWED)).toBeNull();
  });

  it('returns null when the Origin does not match the allowlist -- falls through to the CORS-less OPTIONS answer Next.js gives on its own', () => {
    const request = new Request('http://localhost/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(corsPreflightResponse(request, ALLOWED)).toBeNull();
  });

  it('returns null when there is no Origin header at all', () => {
    const request = new Request('http://localhost/api/v1/auth/login', { method: 'OPTIONS' });
    expect(corsPreflightResponse(request, ALLOWED)).toBeNull();
  });

  it('answers a matching preflight with 204 and the full set of CORS headers', () => {
    const request = new Request('http://localhost/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'capacitor://localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-client-platform',
      },
    });
    const response = corsPreflightResponse(request, ALLOWED);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(response?.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response?.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response?.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(response?.headers.get('access-control-allow-headers')).toContain('x-client-platform');
    expect(response?.headers.get('access-control-max-age')).toBeTruthy();
  });
});
