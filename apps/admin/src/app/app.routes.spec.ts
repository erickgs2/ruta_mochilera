import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { appRoutes } from './app.routes';

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

async function signInAndOpen(permissions: string[], url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter(appRoutes),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: BreakpointObserver, useValue: { observe: () => of({ matches: true }) } },
    ],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', userWith(permissions));
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return { harness, router: TestBed.inject(Router) };
}

describe('admin routes: where staff land', () => {
  afterEach(() => localStorage.clear());

  it('lands the root on trips for someone holding trip.view', async () => {
    const { router } = await signInAndOpen(['trip.view', 'reservation.view'], '/');
    expect(router.url).toBe('/trips');
  });

  it('lands the root on the first section allowed when trip.view is missing', async () => {
    const { router } = await signInAndOpen(['reservation.view', 'customer.view'], '/');
    expect(router.url).toBe('/reservations');
  });

  it('lands the root on forbidden, with nothing to loop back to, when no section is allowed', async () => {
    const { harness, router } = await signInAndOpen([], '/');
    expect(router.url).toBe('/forbidden');
    expect(harness.routeNativeElement?.querySelector('.forbidden a')).toBeNull();
  });

  it('sends the forbidden back button to a section the user can open, never to /', async () => {
    const { harness, router } = await signInAndOpen(['customer.view'], '/trips');
    expect(router.url).toBe('/forbidden');
    const back = harness.routeNativeElement?.querySelector('.forbidden a');
    expect(back?.getAttribute('href')).toBe('/customers');
  });
});
