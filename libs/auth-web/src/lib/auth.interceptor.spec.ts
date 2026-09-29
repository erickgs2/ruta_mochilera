import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('authInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '' },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  it('adds no Authorization header when there is no session', () => {
    http.get('/api/v1/trips').subscribe();
    expect(controller.expectOne('/api/v1/trips').request.headers.has('Authorization')).toBe(false);
  });

  it('attaches the bearer token when a session exists', () => {
    auth.setSessionForTesting('access-1', 'refresh-1');
    http.get('/api/v1/trips').subscribe();
    expect(controller.expectOne('/api/v1/trips').request.headers.get('Authorization')).toBe('Bearer access-1');
  });

  it('refreshes once on 401 and retries the original request', () => {
    auth.setSessionForTesting('expired', 'refresh-1');
    let body: unknown;
    http.get('/api/v1/trips').subscribe((response) => (body = response));

    controller.expectOne('/api/v1/trips').flush(null, { status: 401, statusText: 'Unauthorized' });
    controller.expectOne('/api/v1/auth/refresh').flush({
      user: { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions: [] },
      tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresInSeconds: 900 },
    });

    const retried = controller.expectOne('/api/v1/trips');
    expect(retried.request.headers.get('Authorization')).toBe('Bearer access-2');
    retried.flush([{ id: 't1' }]);
    expect(body).toEqual([{ id: 't1' }]);
  });

  it('a burst of parallel 401s triggers exactly one refresh call', () => {
    auth.setSessionForTesting('expired', 'refresh-1');
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
      tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresInSeconds: 900 },
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
    auth.setSessionForTesting('expired', 'refresh-1');
    http.post('/api/v1/auth/refresh', {}).subscribe({ error: () => undefined });

    controller.expectOne('/api/v1/auth/refresh').flush(null, { status: 401, statusText: 'Unauthorized' });
    controller.verify(); // no additional call was made
  });
});
