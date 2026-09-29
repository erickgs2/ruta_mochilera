import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { TripsListComponent } from './trips-list.component';

const trips = [
  {
    id: 'trip-1',
    slug: 'oaxaca-2026',
    status: 'DRAFT',
    name: 'Oaxaca Mágica',
    departureDate: '2026-11-01T00:00:00.000Z',
    totalCapacity: 20,
    availableSeats: 20,
    pricePerSeatCents: 174_000,
  },
  {
    id: 'trip-2',
    slug: 'chiapas-2026',
    status: 'PUBLISHED',
    name: 'Chiapas Profundo',
    departureDate: '2026-12-01T00:00:00.000Z',
    totalCapacity: 15,
    availableSeats: 10,
    pricePerSeatCents: 210_000,
  },
];

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

function configure(): void {
  TestBed.configureTestingModule({
    imports: [TripsListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips/new', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
}

describe('TripsListComponent', () => {
  it('loads the initial list on creation with no filters applied', () => {
    configure();
    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();

    const request = TestBed.inject(HttpTestingController).expectOne(
      (req) => req.url === '/api/v1/trips' && req.params.get('status') === null && req.params.get('search') === null
    );
    request.flush(trips);
    fixture.detectChanges();

    expect(fixture.componentInstance.trips()).toHaveLength(2);
  });

  it('re-queries the API when the status filter changes', () => {
    configure();
    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne((req) => req.url === '/api/v1/trips').flush(trips);

    fixture.componentInstance.filters.controls.status.setValue('PUBLISHED');

    const request = httpMock.expectOne(
      (req) => req.url === '/api/v1/trips' && req.params.get('status') === 'PUBLISHED'
    );
    request.flush([trips[1]]);

    expect(fixture.componentInstance.trips()).toHaveLength(1);
  });

  it('shows the "new trip" action to a user with trip.create', () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', 'refresh', userWith(['trip.create']));

    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).innerHTML).toContain('trips-new-button');
  });

  it('hides the "new trip" action from a user without trip.create', () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', 'refresh', userWith(['trip.view']));

    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).innerHTML).not.toContain('trips-new-button');
  });

  it('assigns the warn colour to a cancelled trip and no colour to a draft', () => {
    configure();
    const fixture = TestBed.createComponent(TripsListComponent);
    expect(fixture.componentInstance.statusColor('CANCELLED')).toBe('warn');
    expect(fixture.componentInstance.statusColor('DRAFT')).toBeUndefined();
  });
});
