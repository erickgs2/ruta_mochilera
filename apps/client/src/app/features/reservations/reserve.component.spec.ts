import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { customer, reservation, tripDetail } from '../../testing/reservation-fixtures';
import { ReserveComponent } from './reserve.component';

async function open(user = customer()) {
  localStorage.clear();
  localStorage.setItem('rm.locale', 'es');
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips/:slug/reserve', component: ReserveComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'reserve.verifyInvite',
      'reserve.total',
      'reserve.minimumDeposit',
      'reserve.suggestedMonthly',
      'errors.TRIP_SOLD_OUT',
      'errors.EMAIL_NOT_VERIFIED',
      'errors.UNKNOWN',
    ])
  );
  TestBed.inject(LanguageService).use('es');
  TestBed.inject(AuthService).setSessionForTesting('access-1', user);

  const harness = await RouterTestingHarness.create();
  const component = await harness.navigateByUrl('/trips/oaxaca-magica/reserve', ReserveComponent);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/public/trips/oaxaca-magica').flush(tripDetail());
  // Re-read on purpose: the cached user may predate a verification.
  http.expectOne('/api/v1/me').flush(user);
  harness.detectChanges();
  return { harness, component, http };
}

function element(harness: RouterTestingHarness): HTMLElement {
  return harness.routeNativeElement as HTMLElement;
}

async function reserve(harness: RouterTestingHarness, component: ReserveComponent, http: HttpTestingController, reply: object, status = 201) {
  const submitted = component.reserve();
  const request = http.expectOne('/api/v1/reservations');
  request.flush(reply, status === 201 ? { status: 201, statusText: 'Created' } : { status, statusText: 'Error' });
  await submitted;
  harness.detectChanges();
  return request;
}

describe('ReserveComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('creates the hold for the trip id from the catalogue', async () => {
    const { harness, component, http } = await open();

    const request = await reserve(harness, component, http, reservation());

    expect(request.request.body).toEqual({ tripId: 'trip-1' });
  });

  it('shows the total, minimum deposit and suggested monthly payment exactly as the API sent them', async () => {
    const { harness, component, http } = await open();

    await reserve(
      harness,
      component,
      http,
      reservation({ totalPriceCents: 500_000, minimumDepositCents: 100_000, suggestedMonthlyCents: 12_345 })
    );

    const text = element(harness).textContent ?? '';
    expect(text).toContain(formatMoney(500_000, 'es'));
    expect(text).toContain(formatMoney(100_000, 'es'));
    expect(text).toContain(formatMoney(12_345, 'es'));
  });

  it('shows TRIP_SOLD_OUT translated when the trip sold out meanwhile, and does not stay loading', async () => {
    const { harness, component, http } = await open();

    await reserve(harness, component, http, { code: 'TRIP_SOLD_OUT', title: 'Conflict' }, 409);

    expect(element(harness).textContent).toContain(shown('errors.TRIP_SOLD_OUT'));
    expect(component.loading()).toBe(false);
    const button = element(harness).querySelector('.reserve-submit') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
  });

  it('shows the invitation to verify instead of the reserve button to a customer whose email is not verified', async () => {
    const { harness } = await open(customer({ emailVerified: false }));

    expect(element(harness).querySelector('.reserve-verify-invite')).not.toBeNull();
    expect(element(harness).textContent).toContain(shown('reserve.verifyInvite'));
    expect(element(harness).querySelector('.reserve-submit')).toBeNull();
  });

  it('falls back to the invitation when the API answers EMAIL_NOT_VERIFIED', async () => {
    const { harness, component, http } = await open();

    await reserve(harness, component, http, { code: 'EMAIL_NOT_VERIFIED', title: 'Forbidden' }, 403);

    expect(element(harness).querySelector('.reserve-verify-invite')).not.toBeNull();
    expect(element(harness).querySelector('.reserve-submit')).toBeNull();
    expect(component.loading()).toBe(false);
  });

  it('never shows backend text: an unknown code renders the generic message', async () => {
    const { harness, component, http } = await open();

    await reserve(harness, component, http, { code: 'BRAND_NEW_CODE', title: 'Backend sentence' }, 409);

    const text = element(harness).textContent ?? '';
    expect(text).toContain(shown('errors.UNKNOWN'));
    expect(text).not.toContain('BRAND_NEW_CODE');
    expect(text).not.toContain('Backend sentence');
  });
});
