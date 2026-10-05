import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { hashPassword } from '@rm/domain-identity';
import { POST as loginRoute } from './login/route';
import { POST as refreshRoute } from './refresh/route';
import { POST as logoutRoute } from './logout/route';
import { GET as meRoute } from '../me/route';

const db = withTestDb();

const post = (handler: typeof loginRoute, body: unknown) =>
  handler(new Request('http://localhost/api/v1/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

/**
 * The refresh/logout routes take no body at all now -- the refresh token
 * travels only as the `rm_refresh_token` cookie (see
 * `../../../../../lib/http/refresh-cookie.ts`). `postWithCookie` is what
 * exercises that real path instead of constructing a `Request` that skips it:
 * it reads the `Set-Cookie` header off a prior response (typically login) and
 * replays it as the `Cookie` header on the next request, exactly as a browser
 * would.
 */
function postWithCookie(handler: typeof refreshRoute, cookie: string | null) {
  return handler(
    new Request('http://localhost/api/v1/auth', {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    })
  );
}

/** Extracts the `rm_refresh_token=...` pair (name and value only, no attributes) from a `Set-Cookie` header. */
function cookiePairFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('response carried no Set-Cookie header');
  const pair = setCookie.split(';')[0];
  if (!pair) throw new Error('malformed Set-Cookie header');
  return pair;
}

async function seedAdmin() {
  const permission = await db.permission.create({
    data: { key: 'trip.view', category: 'trips', description: 'View trips' },
  });
  const role = await db.role.create({ data: { name: 'Viewer', description: 'Read only' } });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  await db.user.create({
    data: {
      email: 'admin@agency.test',
      type: 'STAFF',
      passwordHash: await hashPassword('Correct-Horse-1'),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: 'Admin' } },
      roles: { create: { roleId: role.id } },
    },
  });
}

describe('auth endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeTestDb());

  it('logs in, sets the refresh token only as an httpOnly/Secure/SameSite=Strict cookie, and never in the JSON body', async () => {
    await seedAdmin();
    const response = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.permissions).toEqual(['trip.view']);
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.tokens).not.toHaveProperty('refreshToken');

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('rm_refresh_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/v1/auth');
  });

  it('rejects a text/plain login attempt with 415 and issues no Set-Cookie (login CSRF)', async () => {
    // This is the finding itself: `SameSite=Strict` protects the cookie
    // `/auth/refresh` and `/auth/logout` *read*, but `/auth/login` *sets*
    // one, and `SameSite` says nothing about whether a browser stores an
    // incoming `Set-Cookie`. Without the `Content-Type` check, a
    // cross-origin `fetch` with `Content-Type: text/plain` -- CORS
    // safelisted, so no preflight -- could reach this public endpoint with
    // a raw JSON body and have the attacker's own credentials silently
    // adopted in the victim's browser. Requiring `application/json` removes
    // the safelisted path (see `parseBody` in `lib/http/route.ts`).
    await seedAdmin();

    const response = await loginRoute(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ email: 'admin@agency.test', password: 'Correct-Horse-1' }),
      })
    );

    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns 401 problem+json on bad credentials', async () => {
    await seedAdmin();
    const response = await post(loginRoute, { email: 'admin@agency.test', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 422 when the body fails validation', async () => {
    const response = await post(loginRoute, { email: 'not-an-email' });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('rejects /me without a token', async () => {
    const response = await meRoute(new Request('http://localhost/api/v1/me'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('TOKEN_INVALID');
  });

  it('returns the profile for an authenticated caller', async () => {
    await seedAdmin();
    const login = await (await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' })).json();

    const response = await meRoute(
      new Request('http://localhost/api/v1/me', {
        headers: { authorization: `Bearer ${login.tokens.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).email).toBe('admin@agency.test');
  });

  it('rejects /refresh with no cookie at all', async () => {
    const response = await postWithCookie(refreshRoute, null);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('TOKEN_INVALID');
    // Even with nothing to clear, the response still carries an expiring cookie.
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rotates the session when the browser presents the refresh cookie', async () => {
    await seedAdmin();
    const login = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
    const cookie = cookiePairFrom(login);

    const refreshed = await postWithCookie(refreshRoute, cookie);
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json();
    expect(refreshedBody.tokens.accessToken).toBeTruthy();
    expect(refreshedBody.tokens).not.toHaveProperty('refreshToken');
    // The rotation issued a new cookie, distinct from the one just spent.
    expect(cookiePairFrom(refreshed)).not.toBe(cookie);
  });

  it('rejects a replayed refresh cookie with 401 TOKEN_REUSED and clears the cookie', async () => {
    await seedAdmin();
    const login = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
    const cookie = cookiePairFrom(login);

    await postWithCookie(refreshRoute, cookie);
    const replay = await postWithCookie(refreshRoute, cookie);

    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe('TOKEN_REUSED');
    expect(replay.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('logs out via the cookie, revokes the session and clears the cookie', async () => {
    await seedAdmin();
    const login = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
    const cookie = cookiePairFrom(login);

    const logout = await postWithCookie(logoutRoute, cookie);
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    // The revoked cookie no longer refreshes a session.
    const afterLogout = await postWithCookie(refreshRoute, cookie);
    expect(afterLogout.status).toBe(401);
  });

  it('logging out with no cookie at all still succeeds (idempotent) and clears the cookie', async () => {
    const response = await postWithCookie(logoutRoute, null);
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  // Task 15b: the packaged Capacitor app's httpOnly cookie never survives
  // (SameSite=Strict, cross-origin WebView -- see task-15-report.md), so it
  // identifies itself with `X-Client-Platform: native` and gets the refresh
  // token delivered in-band instead. Every test above this point sends no
  // such header and must keep behaving exactly as it always has -- that is
  // the actual, enforced version of "a web caller never gets the refresh
  // token in the body", now proven at the route level rather than only in
  // the contract's own unit test.
  describe('the native transport (X-Client-Platform: native, X-Refresh-Token)', () => {
    function postNative(handler: typeof loginRoute, body: unknown) {
      return handler(
        new Request('http://localhost/api/v1/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-platform': 'native' },
          body: JSON.stringify(body),
        })
      );
    }

    function postNativeWithToken(handler: typeof refreshRoute, refreshToken: string | null) {
      return handler(
        new Request('http://localhost/api/v1/auth', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-client-platform': 'native',
            ...(refreshToken ? { 'x-refresh-token': refreshToken } : {}),
          },
        })
      );
    }

    it('login delivers the refresh token in the JSON body and sets no cookie', async () => {
      await seedAdmin();
      const response = await postNative(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tokens.accessToken).toBeTruthy();
      expect(typeof body.tokens.refreshToken).toBe('string');
      expect(body.tokens.refreshToken.length).toBeGreaterThan(0);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('a plain web login (no header) never carries a refresh token in the body, even though the schema now allows the field', async () => {
      await seedAdmin();
      const response = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
      const body = await response.json();
      expect(body.tokens).not.toHaveProperty('refreshToken');
    });

    it('refreshes using the token from the body -- no cookie at all, exactly the native caller\'s real situation', async () => {
      await seedAdmin();
      const login = await postNative(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
      const { refreshToken } = (await login.json()).tokens;

      const refreshed = await postNativeWithToken(refreshRoute, refreshToken);

      expect(refreshed.status).toBe(200);
      const refreshedBody = await refreshed.json();
      expect(refreshedBody.tokens.accessToken).toBeTruthy();
      expect(typeof refreshedBody.tokens.refreshToken).toBe('string');
      expect(refreshed.headers.get('set-cookie')).toBeNull();
    });

    // The header is a client's *claim*, and a same-origin script can make it
    // too: an XSS payload on the admin panel could POST /auth/refresh with
    // `X-Client-Platform: native` and the browser would still attach the
    // httpOnly cookie. If the claim alone decided the transport, the rotated
    // refresh token would land in a JSON body that script can read --
    // exactly what the httpOnly cookie exists to prevent. A refresh that was
    // authenticated BY the cookie therefore always answers on the cookie
    // transport, whatever the header says.
    it('a cookie-authenticated refresh never moves the token into the body, even when the caller claims to be native', async () => {
      await seedAdmin();
      const login = await post(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
      const cookie = cookiePairFrom(login);

      const refreshed = await refreshRoute(
        new Request('http://localhost/api/v1/auth', {
          method: 'POST',
          headers: { cookie, 'x-client-platform': 'native' },
        })
      );

      expect(refreshed.status).toBe(200);
      expect((await refreshed.json()).tokens).not.toHaveProperty('refreshToken');
      expect(cookiePairFrom(refreshed)).not.toBe(cookie);
    });

    it('rejects a refresh with no cookie and no body token', async () => {
      const response = await postNativeWithToken(refreshRoute, null);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('TOKEN_INVALID');
    });

    it('logs out using the token from the body and revokes the session', async () => {
      await seedAdmin();
      const login = await postNative(loginRoute, { email: 'admin@agency.test', password: 'Correct-Horse-1' });
      const { refreshToken } = (await login.json()).tokens;

      const logout = await postNativeWithToken(logoutRoute, refreshToken);
      expect(logout.status).toBe(204);

      const afterLogout = await postNativeWithToken(refreshRoute, refreshToken);
      expect(afterLogout.status).toBe(401);
    });
  });
});
