import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { STRIPE_PUBLISHABLE_KEY } from '../../core/stripe/stripe-loader';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { reservation, type ReservationDetail } from '../../testing/reservation-fixtures';
import { PROCESSING_POLL_ATTEMPTS, PROCESSING_POLL_INTERVAL_MS, ReservationDetailComponent } from './reservation-detail.component';

const HOUR = 60 * 60 * 1000;

async function open(first: ReservationDetail, url = '/reservations/res-1') {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'reservations/:id', component: ReservationDetailComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: STRIPE_PUBLISHABLE_KEY, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'reservation.status.HELD',
      'reservation.status.ACTIVE',
      'reservation.status.EXPIRED',
      'reservation.holdExpired',
      'reservation.processing',
      'reservation.processingSlow',
      'errors.RESERVATION_NOT_OWNED',
      'errors.UNKNOWN',
    ])
  );
  TestBed.inject(LanguageService).use('es');
  const harness = await RouterTestingHarness.create();
  const component = await harness.navigateByUrl(url, ReservationDetailComponent);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/reservations/res-1').flush(first);
  harness.detectChanges();
  return { harness, component, http };
}

function element(harness: RouterTestingHarness): HTMLElement {
  return harness.routeNativeElement as HTMLElement;
}

describe('ReservationDetailComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    jest.useRealTimers();
  });

  it('shows a HELD reservation with a countdown to the end of the hold that keeps ticking', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-05T12:00:00.000Z') });
    const { harness } = await open(reservation({ holdExpiresAt: new Date(Date.now() + 2 * HOUR).toISOString() }));

    expect(element(harness).textContent).toContain(shown('reservation.status.HELD'));
    expect(element(harness).querySelector('.hold-countdown')?.textContent).toContain('02:00:00');

    jest.advanceTimersByTime(61_000);
    harness.detectChanges();
    expect(element(harness).querySelector('.hold-countdown')?.textContent).toContain('01:58:59');
  });

  it('when the hold runs out, refreshing shows the reservation as expired and no way to pay it', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-05T12:00:00.000Z') });
    const { harness, component, http } = await open(reservation({ holdExpiresAt: new Date(Date.now() + 1000).toISOString() }));

    jest.advanceTimersByTime(2000);
    harness.detectChanges();
    expect(element(harness).textContent).toContain(shown('reservation.holdExpired'));

    component.refresh();
    http
      .expectOne('/api/v1/reservations/res-1')
      .flush(reservation({ status: 'EXPIRED', holdExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    harness.detectChanges();

    expect(element(harness).textContent).toContain(shown('reservation.status.EXPIRED'));
    expect(element(harness).querySelector('.hold-countdown')).toBeNull();
    expect(element(harness).querySelector('rm-payment-method')).toBeNull();
  });

  it('shows the amounts the API sent, suggested monthly payment included', async () => {
    const { harness } = await open(
      reservation({ totalPriceCents: 500_000, paidCents: 100_000, balanceCents: 400_000, suggestedMonthlyCents: 12_345 })
    );

    const text = element(harness).textContent ?? '';
    expect(text).toContain(formatMoney(500_000, 'es'));
    expect(text).toContain(formatMoney(100_000, 'es'));
    expect(text).toContain(formatMoney(400_000, 'es'));
    expect(text).toContain(formatMoney(12_345, 'es'));
  });

  it('after a card confirmation it shows "processing" and polls until the webhook has credited the payment', async () => {
    jest.useFakeTimers();
    const { harness, component, http } = await open(reservation({ paidCents: 0 }));

    component.onCardConfirmed();
    harness.detectChanges();
    expect(element(harness).textContent).toContain(shown('reservation.processing'));

    jest.advanceTimersByTime(PROCESSING_POLL_INTERVAL_MS);
    http.expectOne('/api/v1/reservations/res-1').flush(reservation({ paidCents: 0 }));
    harness.detectChanges();
    expect(element(harness).textContent).toContain(shown('reservation.processing'));

    jest.advanceTimersByTime(PROCESSING_POLL_INTERVAL_MS);
    http
      .expectOne('/api/v1/reservations/res-1')
      .flush(reservation({ status: 'ACTIVE', holdExpiresAt: null, paidCents: 100_000, balanceCents: 400_000 }));
    harness.detectChanges();

    expect(element(harness).textContent).not.toContain(shown('reservation.processing'));
    expect(element(harness).textContent).toContain(shown('reservation.status.ACTIVE'));
  });

  it('stops polling after a bounded number of attempts and says the payment is still being processed', async () => {
    jest.useFakeTimers();
    const { harness, component, http } = await open(reservation({ paidCents: 0 }));

    component.onCardConfirmed();
    for (let attempt = 0; attempt < PROCESSING_POLL_ATTEMPTS; attempt++) {
      jest.advanceTimersByTime(PROCESSING_POLL_INTERVAL_MS);
      http.expectOne('/api/v1/reservations/res-1').flush(reservation({ paidCents: 0 }));
    }
    jest.advanceTimersByTime(PROCESSING_POLL_INTERVAL_MS * 3);
    http.expectNone('/api/v1/reservations/res-1');
    harness.detectChanges();

    expect(element(harness).textContent).toContain(shown('reservation.processingSlow'));
  });

  it('starts in "processing" when opened right after a card payment', async () => {
    jest.useFakeTimers();
    const { harness, http } = await open(reservation(), '/reservations/res-1?processing=1');

    expect(element(harness).textContent).toContain(shown('reservation.processing'));
    jest.advanceTimersByTime(PROCESSING_POLL_INTERVAL_MS);
    http.expectOne('/api/v1/reservations/res-1').flush(reservation({ status: 'ACTIVE', holdExpiresAt: null, paidCents: 100_000, balanceCents: 400_000 }));
  });

  it("shows RESERVATION_NOT_OWNED translated for someone else's reservation", async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'reservations/:id', component: ReservationDetailComponent }]),
        provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
        { provide: API_BASE_URL, useValue: '' },
      ],
    });
    TestBed.inject(TranslateService).setTranslation('es', keyedTranslations(['errors.RESERVATION_NOT_OWNED', 'errors.UNKNOWN']));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/reservations/res-1', ReservationDetailComponent);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/reservations/res-1')
      .flush({ code: 'RESERVATION_NOT_OWNED', title: 'Not Found' }, { status: 404, statusText: 'Not Found' });
    harness.detectChanges();

    expect(element(harness).textContent).toContain(shown('errors.RESERVATION_NOT_OWNED'));
  });
});
