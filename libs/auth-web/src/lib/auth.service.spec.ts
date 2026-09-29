import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from './auth.service';

const session = {
  user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: ['trip.view'] },
  tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSeconds: 900 },
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

  it('restores a persisted session on start-up', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    const fresh = new AuthService();
    expect(fresh.refreshToken()).toBe('refresh-1');
  });

  it('clears everything on logout', async () => {
    const promise = service.login('a@b.test', 'secret');
    http.expectOne('/api/v1/auth/login').flush(session);
    await promise;

    const logout = service.logout();
    http.expectOne('/api/v1/auth/logout').flush({});
    await logout;

    expect(service.isAuthenticated()).toBe(false);
    expect(service.refreshToken()).toBeNull();
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
    expect(service.refreshToken()).toBeNull();
    expect(localStorage.getItem('rm.session')).toBeNull();
  });
});
