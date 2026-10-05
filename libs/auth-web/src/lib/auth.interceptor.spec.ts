import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { REFRESH_TOKEN_STORE, type RefreshTokenStore } from './refresh-token-store';

/** A store that always has something to report, so its effects on the interceptor are observable. */
class FakeNativeRefreshTokenStore implements RefreshTokenStore {
  token: string | null = null;
  persisted: Array<{ refreshToken?: string }> = [];

  requestHeaders({ includeRefreshToken }: { includeRefreshToken: boolean }): Record<string, string> {
    const headers: Record<string, string> = { 'X-Client-Platform': 'native' };
    if (includeRefreshToken && this.token) headers['X-Refresh-Token'] = this.token;
    return headers;
  }

  async persist(tokens: { refreshToken?: string }): Promise<void> {
    this.persisted.push(tokens);
    if (tokens.refreshToken) this.token = tokens.refreshToken;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}

describe('authInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let auth: AuthService;
  let router: Router;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([{ path: 'login', children: [] }]),
        { provide: API_BASE_URL, useValue: '' },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
  });

  it('adds no Authorization header when there is no session', () => {
    http.get('/api/v1/trips').subscribe();
    expect(controller.expectOne('/api/v1/trips').request.headers.has('Authorization')).toBe(false);
  });

  it('attaches the bearer token when a session exists', () => {
    auth.setSessionForTesting('access-1');
    http.get('/api/v1/trips').subscribe();
    expect(controller.expectOne('/api/v1/trips').request.headers.get('Authorization')).toBe('Bearer access-1');
  });

  it('refreshes once on 401 and retries the original request', () => {
    auth.setSessionForTesting('expired', { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] });
    let body: unknown;
    http.get('/api/v1/trips').subscribe((response) => (body = response));

    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    // No body in the refresh request: the token travels via the (mocked,
    // invisible-to-the-test) refresh-token cookie, not JSON.
    controller.expectOne('/api/v1/auth/refresh').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-2', expiresInSeconds: 900 },
    });

    const retried = controller.expectOne('/api/v1/trips');
    expect(retried.request.headers.get('Authorization')).toBe('Bearer access-2');
    retried.flush([{ id: 't1' }]);
    expect(body).toEqual([{ id: 't1' }]);
  });

  it('a burst of parallel 401s triggers exactly one refresh call', () => {
    auth.setSessionForTesting('expired', { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] });
    const bodies: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      http.get(`/api/v1/trips?i=${i}`).subscribe((response) => bodies.push(response));
    }

    // All five original requests fail with 401 before the refresh is answered.
    for (let i = 0; i < 5; i += 1) {
      controller.expectOne(`/api/v1/trips?i=${i}`).flush(null, { status: 401, statusText: 'Unauthorized' });
    }

    // Exactly one refresh call must have been made -- expectOne throws if there is
    // more than one match, which is what makes this assertion meaningful.
    controller.expectOne('/api/v1/auth/refresh').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-2', expiresInSeconds: 900 },
    });

    // All five losers retry with the new token.
    for (let i = 0; i < 5; i += 1) {
      const retried = controller.expectOne(`/api/v1/trips?i=${i}`);
      expect(retried.request.headers.get('Authorization')).toBe('Bearer access-2');
      retried.flush([{ id: `t${i}` }]);
    }
    expect(bodies).toHaveLength(5);
  });

  it('does not try to refresh the refresh call itself', () => {
    auth.setSessionForTesting('expired', { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] });
    http.post('/api/v1/auth/refresh', {}).subscribe({ error: () => undefined });

    controller.expectOne('/api/v1/auth/refresh').flush(null, { status: 401, statusText: 'Unauthorized' });
    controller.verify(); // no additional call was made
  });

  it('does not attempt a refresh at all when there is no local session', () => {
    // No cookie is visible to this test either way, but the point here is
    // that an anonymous caller (never logged in on this device) must not
    // even try: there is nothing for a successful refresh to attach to.
    http.get('/api/v1/trips').subscribe({ error: () => undefined });
    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    controller.verify(); // no refresh call was made
  });

  it('logs the user out and routes to /login when the refresh call itself fails', () => {
    auth.setSessionForTesting('expired', {
      id: 'u1',
      email: 'a@b.test',
      type: 'STAFF',
      locale: 'es',
      fullName: 'Ana',
      permissions: ['trip.view'],
    });
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    let receivedError: unknown;
    http.get('/api/v1/trips').subscribe({ error: (error) => (receivedError = error) });

    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    // The refresh token itself is invalid/expired -- the refresh call fails too.
    controller.expectOne('/api/v1/auth/refresh').flush(null, {
      status: 401,
      statusText: 'Unauthorized',
    });

    // 1. The local session is cleared -- a dead refresh token must not leave
    //    the user looking signed in.
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.accessToken()).toBeNull();

    // 2. The user is routed to the login screen.
    expect(navigateSpy).toHaveBeenCalledWith(['/login']);

    // 3. The original failure (the 401 on /api/v1/trips) propagates to the
    //    caller -- not the refresh call's own error, and not silently swallowed.
    expect(receivedError).toBeInstanceOf(HttpErrorResponse);
    expect((receivedError as HttpErrorResponse).status).toBe(401);
    expect((receivedError as HttpErrorResponse).url).toContain('/api/v1/trips');
  });
});

// Task 15b: a platform-aware RefreshTokenStore. The interceptor must attach
// its `requestHeaders()` uniformly and hand a successful refresh's tokens to
// `persist()` -- without ever branching on platform itself. Every test above
// this point never provides REFRESH_TOKEN_STORE and still passes, which is
// the proof that the default (web) request/refresh shape is unchanged.
describe('authInterceptor with an injected RefreshTokenStore', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let auth: AuthService;
  let store: FakeNativeRefreshTokenStore;

  beforeEach(() => {
    localStorage.clear();
    store = new FakeNativeRefreshTokenStore();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([{ path: 'login', children: [] }]),
        { provide: API_BASE_URL, useValue: '' },
        { provide: REFRESH_TOKEN_STORE, useValue: store },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  it("attaches the store's platform header alongside the bearer token, but never the refresh token on an ordinary request", () => {
    // The refresh token is long-lived; it must only travel on the two calls
    // that actually consume it, not on every API request where it would end
    // up in every access log and proxy along the way.
    store.token = 'native-refresh-1';
    auth.setSessionForTesting('access-1');
    http.get('/api/v1/trips').subscribe();

    const req = controller.expectOne('/api/v1/trips');
    expect(req.request.headers.get('Authorization')).toBe('Bearer access-1');
    expect(req.request.headers.get('X-Client-Platform')).toBe('native');
    expect(req.request.headers.has('X-Refresh-Token')).toBe(false);
    req.flush([]);
  });

  it('attaches the refresh token to the refresh call the interceptor itself makes', () => {
    store.token = 'native-refresh-1';
    auth.setSessionForTesting('expired', { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] });
    http.get('/api/v1/trips').subscribe({ error: () => undefined });

    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    const refresh = controller.expectOne('/api/v1/auth/refresh');
    expect(refresh.request.headers.get('X-Refresh-Token')).toBe('native-refresh-1');
    refresh.flush(null, { status: 401, statusText: 'Unauthorized' });
  });

  it('attaches the refresh token to the logout call, so the server can revoke it', () => {
    store.token = 'native-refresh-1';
    http.post('/api/v1/auth/logout', {}).subscribe();

    const logout = controller.expectOne('/api/v1/auth/logout');
    expect(logout.request.headers.get('X-Refresh-Token')).toBe('native-refresh-1');
    logout.flush(null);
  });

  it('attaches the store headers even with no local session (e.g. the login call itself)', () => {
    http.post('/api/v1/auth/login', {}).subscribe({ error: () => undefined });
    const req = controller.expectOne('/api/v1/auth/login');
    expect(req.request.headers.get('X-Client-Platform')).toBe('native');
    req.flush(null, { status: 401, statusText: 'Unauthorized' });
  });

  it('hands a successful refresh response to the store', () => {
    auth.setSessionForTesting('expired', { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] });
    http.get('/api/v1/trips').subscribe();

    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    controller.expectOne('/api/v1/auth/refresh').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-2', refreshToken: 'native-refresh-2', expiresInSeconds: 900 },
    });

    expect(store.persisted).toEqual([{ accessToken: 'access-2', refreshToken: 'native-refresh-2', expiresInSeconds: 900 }]);
    controller.expectOne('/api/v1/trips').flush([]);
  });
});
