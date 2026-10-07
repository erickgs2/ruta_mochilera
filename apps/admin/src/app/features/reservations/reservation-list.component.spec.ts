import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { ReservationListComponent } from './reservation-list.component';

const reservations = [
  {
    id: 'res-pending',
    code: 'RM-AAAA-BBBB',
    tripId: 'trip-1',
    tripName: 'Oaxaca Mágica',
    tripDepartureDate: '2027-12-01T00:00:00.000Z',
    customerId: 'cust-1',
    customerName: 'Ana Pérez',
    status: 'ACTIVE',
    holdExpiresAt: null,
    totalPriceCents: 500_000,
    paidCents: 100_000,
    balanceCents: 400_000,
    paymentDeadline: '2027-11-01T00:00:00.000Z',
    cancellationRequestedAt: '2027-01-02T10:00:00.000Z',
    cancellationPending: true,
    createdAt: '2027-01-01T10:00:00.000Z',
  },
  {
    id: 'res-plain',
    code: 'RM-CCCC-DDDD',
    tripId: 'trip-1',
    tripName: 'Oaxaca Mágica',
    tripDepartureDate: '2027-12-01T00:00:00.000Z',
    customerId: 'cust-2',
    customerName: 'Luis Gómez',
    status: 'HELD',
    holdExpiresAt: '2027-01-05T10:00:00.000Z',
    totalPriceCents: 500_000,
    paidCents: 0,
    balanceCents: 500_000,
    paymentDeadline: '2027-11-01T00:00:00.000Z',
    cancellationRequestedAt: null,
    cancellationPending: false,
    createdAt: '2027-01-03T10:00:00.000Z',
  },
];

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

function configure(options: { permissions: string[]; handset?: boolean }) {
  TestBed.configureTestingModule({
    imports: [ReservationListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      ...(options.handset
        ? [{ provide: BreakpointObserver, useValue: { observe: () => of({ matches: true, breakpoints: {} }) } }]
        : []),
    ],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', userWith(options.permissions));
  const fixture = TestBed.createComponent(ReservationListComponent);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController) };
}

describe('ReservationListComponent', () => {
  afterEach(() => localStorage.clear());

  it('loads the list with no filters and highlights the pending cancellation requests', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'] });

    httpMock
      .expectOne(
        (req) =>
          req.url === '/api/v1/admin/reservations' &&
          req.params.keys().length === 0
      )
      .flush(reservations);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tr.mat-mdc-row') as NodeListOf<HTMLElement>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains('reservations-pending')).toBe(true);
    expect(rows[1]?.classList.contains('reservations-pending')).toBe(false);
    expect(rows[0]?.querySelector('.reservations-pending-chip')).not.toBeNull();
    expect(rows[1]?.querySelector('.reservations-pending-chip')).toBeNull();
    expect(fixture.componentInstance.pendingCount()).toBe(1);
    expect(fixture.nativeElement.querySelector('.reservations-pending-summary')).not.toBeNull();
  });

  it('keeps the order the API sent: the work queue is decided server-side', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'] });

    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush([...reservations].reverse());
    fixture.detectChanges();

    expect(fixture.componentInstance.reservations().map((row) => row.id)).toEqual(['res-plain', 'res-pending']);
  });

  it('re-queries with the status and pending filters', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'] });
    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush(reservations);

    fixture.componentInstance.filters.controls.status.setValue('HELD');
    httpMock
      .expectOne((req) => req.url === '/api/v1/admin/reservations' && req.params.get('status') === 'HELD')
      .flush([]);

    fixture.componentInstance.filters.controls.pendingOnly.setValue(true);
    httpMock
      .expectOne(
        (req) =>
          req.url === '/api/v1/admin/reservations' &&
          req.params.get('status') === 'HELD' &&
          req.params.get('cancellationPending') === 'true'
      )
      .flush([]);
  });

  it('offers the trip filter, loaded from the trips list, only with trip.view', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view', 'trip.view'] });
    httpMock.expectOne('/api/v1/trips').flush([{ id: 'trip-1', name: 'Oaxaca Mágica' }]);
    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush(reservations);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reservations-trip-field')).not.toBeNull();

    fixture.componentInstance.filters.controls.tripId.setValue('trip-1');
    httpMock
      .expectOne((req) => req.url === '/api/v1/admin/reservations' && req.params.get('tripId') === 'trip-1')
      .flush([]);
  });

  it('never asks for the trips list without trip.view, and hides that filter', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'] });
    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush(reservations);
    fixture.detectChanges();

    httpMock.expectNone('/api/v1/trips');
    expect(fixture.nativeElement.querySelector('.reservations-trip-field')).toBeNull();
  });

  it('shows the empty state when nothing matches', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'] });
    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush([]);
    fixture.detectChanges();

    expect(fixture.componentInstance.isEmpty()).toBe(true);
    expect(fixture.nativeElement.querySelector('table')).toBeNull();
  });

  it('renders cards on a handset, the pending one marked', () => {
    const { fixture, httpMock } = configure({ permissions: ['reservation.view'], handset: true });
    httpMock.expectOne((req) => req.url === '/api/v1/admin/reservations').flush(reservations);
    fixture.detectChanges();

    const cards = fixture.nativeElement.querySelectorAll('.reservations-card') as NodeListOf<HTMLElement>;
    expect(cards).toHaveLength(2);
    expect(cards[0]?.classList.contains('reservations-pending')).toBe(true);
    expect(fixture.nativeElement.querySelector('table')).toBeNull();
  });
});
