import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from './auth.service';
import { REFRESH_TOKEN_STORE, type RefreshTokenStore } from './refresh-token-store';

/** Records every call this test cares about, instead of asserting on a real secure-storage plugin. */
class RecordingRefreshTokenStore implements RefreshTokenStore {
  persisted: Array<{ refreshToken?: string }> = [];
  cleared = 0;

  requestHeaders(): Record<string, string> {
    return {};
  }

  async persist(tokens: { refreshToken?: string }): Promise<void> {
    this.persisted.push(tokens);
  }

  async clear(): Promise<void> {
    this.cleared += 1;
  }
}

// The refresh token never appears here: it travels only as the httpOnly
// cookie the real API sets (see `apps/api/src/lib/http/refresh-cookie.ts`).
// `HttpTestingController` cannot model `Set-Cookie`/`Cookie` at all, so these
// specs only exercise the JSON body AuthService actually reads.
const session = {
  user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: ['trip.view'] },
  tokens: { accessToken: 'access-1', expiresInSeconds: 900 },
};

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [{ provide: API_BASE_URL, useValue: '' }],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('starts unauthenticated', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.permissions()).toEqual([]);
  });

  it('stores the session after a successful login', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    expect(service.isAuthenticated()).toBe(true);
    expect(service.user()?.fullName).toBe('Ana');
    expect(service.permissions()).toEqual(['trip.view']);
    expect(service.accessToken()).toBe('access-1');
  });

  describe('saving the language', () => {
    it('saves the locale on the server and mirrors it in the stored session', async () => {
      const login = service.login('a@b.test', 'secret');
      http.expectOne('/api/v1/auth/login').flush(session);
      await login;

      const saving = service.saveLocale('en');
      const request = http.expectOne('/api/v1/me');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ locale: 'en' });
      request.flush({ ...session.user, locale: 'en' });
      await saving;

      expect(service.user()?.locale).toBe('en');
      expect(JSON.parse(localStorage.getItem('rm.session') ?? '{}').user.locale).toBe('en');
    });

    it('rejects and leaves the stored locale alone when the server refuses', async () => {
      const login = service.login('a@b.test', 'secret');
      http.expectOne('/api/v1/auth/login').flush(session);
      await login;

      const saving = service.saveLocale('en');
      http.expectOne('/api/v1/me').flush({ code: 'INTERNAL' }, { status: 500, statusText: 'Server Error' });

      await expect(saving).rejects.toBeDefined();
      expect(service.user()?.locale).toBe('es');
    });
  });

  it('restores a persisted session on start-up', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    const fresh = new AuthService();
    expect(fresh.accessToken()).toBe('access-1');
  });

  it('clears everything on logout', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    const logout = service.logout();
    http.expectOne('/api/v1/auth/logout').flush(null);
    await logout;

    expect(service.isAuthenticated()).toBe(false);
    expect(service.accessToken()).toBeNull();
    expect(localStorage.getItem('rm.session')).toBeNull();
  });

  it('answers hasPermission from the loaded session', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    expect(service.hasPermission('trip.view')).toBe(true);
    expect(service.hasPermission('trip.create')).toBe(false);
  });

  it('clears the local session on logout even when the server call fails', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    const logout = service.logout();
    http
      .expectOne('/api/v1/auth/logout')
      .flush(null, { status: 500, statusText: 'Internal Server Error' });
    await logout;

    expect(service.isAuthenticated()).toBe(false);
    expect(service.accessToken()).toBeNull();
    expect(localStorage.getItem('rm.session')).toBeNull();
  });
});

// Task 15b: a platform-aware RefreshTokenStore, injected once at composition.
// AuthService must call it uniformly (no platform branching of its own) --
// these specs prove that by swapping in a fake and watching it get called,
// rather than asserting on the default no-op (already covered above: every
// test there never provides REFRESH_TOKEN_STORE at all, and still passes,
// which is exactly the "web behaviour is unchanged by default" guarantee).
describe('AuthService with an injected RefreshTokenStore', () => {
  let service: AuthService;
  let http: HttpTestingController;
  let store: RecordingRefreshTokenStore;

  beforeEach(() => {
    localStorage.clear();
    store = new RecordingRefreshTokenStore();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [{ provide: API_BASE_URL, useValue: '' }, { provide: REFRESH_TOKEN_STORE, useValue: store }],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('hands the login response tokens to the store', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSeconds: 900 },
    });
    await promise;

    expect(store.persisted).toEqual([{ accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSeconds: 900 }]);
  });

  it('clears the store on logout, alongside the local session', async () => {
    const login = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-1', expiresInSeconds: 900 },
    });
    await login;

    const logout = service.logout();
    http.expectOne('/api/v1/auth/logout').flush(null);
    await logout;

    expect(store.cleared).toBe(1);
  });

  it('clears the store when clear() is called directly (the interceptor\'s failed-refresh path)', () => {
    service.clear();
    expect(store.cleared).toBe(1);
  });
});
