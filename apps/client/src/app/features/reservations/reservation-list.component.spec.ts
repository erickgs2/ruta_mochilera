import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL, type components } from '@rm/api-client';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { ReservationListComponent } from './reservation-list.component';

type ReservationSummary = components['schemas']['ReservationSummary'];

function summary(overrides: Partial<ReservationSummary> = {}): ReservationSummary {
  return {
    id: 'res-1',
    code: 'ABCD2345',
    tripId: 'trip-1',
    tripName: 'Oaxaca Mágica',
    tripDepartureDate: '2028-03-01T00:00:00.000Z',
    status: 'HELD',
    holdExpiresAt: '2026-10-08T00:00:00.000Z',
    totalPriceCents: 500_000,
    paidCents: 0,
    balanceCents: 500_000,
    paymentDeadline: '2028-02-01T00:00:00.000Z',
    createdAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

function setup(rows: ReservationSummary[] | { status: number; body: object }) {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [ReservationListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'reservations.empty',
      'reservation.status.HELD',
      'reservation.status.ACTIVE',
      'reservation.status.CANCELLED',
      'errors.UNKNOWN',
    ])
  );
  TestBed.inject(LanguageService).use('es');
  const fixture = TestBed.createComponent(ReservationListComponent);
  fixture.detectChanges();
  const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/reservations');
  if (Array.isArray(rows)) request.flush(rows);
  else request.flush(rows.body, { status: rows.status, statusText: 'Error' });
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ReservationListComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows one row per reservation with its trip, status and balance, linking to the detail', () => {
    const element = setup([
      summary({ id: 'res-1', tripName: 'Oaxaca Mágica', status: 'HELD', balanceCents: 500_000 }),
      summary({ id: 'res-2', tripName: 'Chiapas', status: 'ACTIVE', balanceCents: 250_000 }),
    ]);

    const rows = Array.from(element.querySelectorAll('.reservation-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Oaxaca Mágica');
    expect(rows[0].textContent).toContain(shown('reservation.status.HELD'));
    expect(rows[0].textContent).toContain(formatMoney(500_000, 'es'));
    expect(rows[1].textContent).toContain('Chiapas');
    expect(rows[1].textContent).toContain(shown('reservation.status.ACTIVE'));
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/reservations/res-1');
    expect(rows[1].querySelector('a')?.getAttribute('href')).toBe('/reservations/res-2');
  });

  it("shows the trip's departure as the stored calendar day", () => {
    const element = setup([summary({ tripDepartureDate: '2028-03-01T00:00:00.000Z' })]);

    expect(element.querySelector('.reservation-row-date')?.textContent).toContain('2028');
  });

  it('keeps cancelled and expired reservations in the history', () => {
    const element = setup([summary({ id: 'res-x', status: 'CANCELLED' })]);

    expect(element.querySelector('.reservation-row')?.textContent).toContain(shown('reservation.status.CANCELLED'));
  });

  it('shows the translated empty state for a customer with no reservations', () => {
    const element = setup([]);

    expect(element.querySelectorAll('.reservation-row')).toHaveLength(0);
    expect(element.textContent).toContain(shown('reservations.empty'));
  });

  it('shows the generic error, not the raw code, when loading fails', () => {
    const element = setup({ status: 500, body: { code: 'SOMETHING_ODD', title: 'Backend text' } });

    expect(element.textContent).toContain(shown('errors.UNKNOWN'));
    expect(element.textContent).not.toContain('SOMETHING_ODD');
  });
});

describe('ReservationListComponent calendar days (America/Mexico_City)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the trip departure as the stored day, not the day before', () => {
    const element = setup([summary({ tripDepartureDate: '2028-03-01T00:00:00.000Z' })]);

    const date = element.querySelector('.reservation-row-date')?.textContent;
    expect(date).toContain('1 mar 2028');
    expect(date).not.toContain('29 feb 2028');
  });
});
