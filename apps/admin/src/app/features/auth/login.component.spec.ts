import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { authGuard, permissionGuard } from '@rm/auth-web';
import { landingRedirect } from '../../layout/landing';
import { LoginComponent } from './login.component';

@Component({ template: '' })
class Stub {}

/** The guards and the root redirect of `app.routes.ts`, with empty screens. */
const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: landingRedirect },
      {
        path: 'trips',
        canActivate: [permissionGuard('trip.view')],
        children: [
          { path: '', component: Stub },
          { path: ':id', component: Stub },
        ],
      },
      {
        path: 'reservations',
        canActivate: [permissionGuard('reservation.view')],
        children: [
          { path: '', component: Stub },
          { path: ':id', component: Stub },
        ],
      },
      { path: 'customers', canActivate: [permissionGuard('customer.view')], children: [{ path: '', component: Stub }] },
      { path: 'forbidden', component: Stub },
    ],
  },
  { path: '**', redirectTo: '' },
];

/** Opens `/login` (with `?returnUrl=` when given), signs in as someone holding `permissions`, and reports where they end up. */
async function signIn(returnUrl: string | null, permissions: string[]): Promise<string> {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter(routes),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const url = returnUrl === null ? '/login' : `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  const login = await harness.navigateByUrl(url, LoginComponent);

  login.form.setValue({ email: 'ana@agency.test', password: 'secret-password' });
  const submitted = login.submit();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/v1/auth/login')
    .flush({
      user: { id: 'u1', email: 'ana@agency.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions },
      tokens: { accessToken: 'access-1', expiresInSeconds: 900 },
    });
  await submitted;
  return TestBed.inject(Router).url;
}

describe('admin LoginComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    localStorage.clear();
  });

  it('goes back to the page the guard interrupted, query string included', async () => {
    expect(await signIn('/reservations/res-1?tab=payments', ['reservation.view'])).toBe('/reservations/res-1?tab=payments');
  });

  it('goes to the first section the user may open when there is no returnUrl, never to /trips by default', async () => {
    expect(await signIn(null, ['reservation.view', 'customer.view'])).toBe('/reservations');
  });

  it('still lands on /trips when trips is the first section the user may open', async () => {
    expect(await signIn(null, ['trip.view', 'customer.view'])).toBe('/trips');
  });

  it('falls back to the first allowed section when the user may not open the returnUrl', async () => {
    const landed = await signIn('/trips/trip-1', ['customer.view']);

    expect(landed).toBe('/customers');
  });

  it('falls back to /forbidden only when the user may open nothing at all', async () => {
    expect(await signIn('/trips/trip-1', [])).toBe('/forbidden');
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example',
    '/@evil.example',
    '/trips/../../evil.example',
    '/\\evil.example',
    '/login',
    '/login?returnUrl=/trips',
    '/forbidden',
  ])('ignores the returnUrl %s and lands on the first allowed section', async (returnUrl) => {
    expect(await signIn(returnUrl, ['reservation.view'])).toBe('/reservations');
  });
});
