import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, UrlTree } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { authGuard, permissionGuard } from './auth.guard';
import { AuthService } from './auth.service';

const staffUser = {
  id: 'u1',
  email: 'a@b.test',
  type: 'STAFF' as const,
  locale: 'es' as const,
  fullName: 'Ana',
  permissions: ['trip.view'],
};

describe('authGuard', () => {
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: API_BASE_URL, useValue: '' },
        provideRouter([{ path: 'login', children: [] }]),
      ],
    });
    auth = TestBed.inject(AuthService);
  });

  it('allows navigation when a session exists', () => {
    auth.setSessionForTesting('access-1', staffUser);
    const result = TestBed.runInInjectionContext(() => authGuard({} as never, {} as never));
    expect(result).toBe(true);
  });

  it('carries the attempted URL to /login as returnUrl', () => {
    const result = TestBed.runInInjectionContext(() =>
      authGuard({} as never, { url: '/trips/ruta-oaxaca/reserve?x=1' } as never)
    );
    expect((result as UrlTree).toString().startsWith('/login?returnUrl=')).toBe(true);
    expect((result as UrlTree).queryParams).toEqual({ returnUrl: '/trips/ruta-oaxaca/reserve?x=1' });
  });

  it('does not carry an external attempted URL', () => {
    const result = TestBed.runInInjectionContext(() => authGuard({} as never, { url: '//evil.example' } as never));
    expect((result as UrlTree).toString()).toBe('/login');
  });

  it('redirects to /login when there is no session', () => {
    const result = TestBed.runInInjectionContext(() => authGuard({} as never, {} as never));
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/login');
  });
});

describe('permissionGuard', () => {
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: API_BASE_URL, useValue: '' },
        provideRouter([
          { path: 'login', children: [] },
          { path: 'forbidden', children: [] },
        ]),
      ],
    });
    auth = TestBed.inject(AuthService);
  });

  it('redirects to /login when unauthenticated', () => {
    const guard = permissionGuard('trip.view');
    const result = TestBed.runInInjectionContext(() => guard({} as never, {} as never));
    expect((result as UrlTree).toString()).toBe('/login');
  });

  it('redirects to /forbidden when authenticated but missing the permission', async () => {
    auth.setSessionForTesting('access-1', staffUser);
    const guard = permissionGuard('trip.create');
    const result = TestBed.runInInjectionContext(() => guard({} as never, {} as never));
    expect((result as UrlTree).toString()).toBe('/forbidden');
  });

  it('allows navigation when authenticated with the permission', () => {
    auth.setSessionForTesting('access-1', {
      id: 'u1',
      email: 'a@b.test',
      type: 'STAFF',
      locale: 'es',
      fullName: 'Ana',
      permissions: ['trip.view'],
    });
    const guard = permissionGuard('trip.view');
    const result = TestBed.runInInjectionContext(() => guard({} as never, {} as never));
    expect(result).toBe(true);
  });
});
