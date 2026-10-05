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

/** Same as `configure()`, but forces `BreakpointObserver` to report the handset breakpoint as matched. */
function configureHandset(): void {
  TestBed.configureTestingModule({
    imports: [TripsListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips/new', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: BreakpointObserver, useValue: { observe: () => of({ matches: true, breakpoints: {} }) } },
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
    auth.setSessionForTesting('access', userWith(['trip.create']));

    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).innerHTML).toContain('trips-new-button');
  });

  it('hides the "new trip" action from a user without trip.create', () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['trip.view']));

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

  it('renders the stacked card layout instead of the table under the handset breakpoint', () => {
    configureHandset();
    const fixture = TestBed.createComponent(TripsListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
    fixture.detectChanges();

    expect(fixture.componentInstance.isHandset()).toBe(true);
    const html = fixture.nativeElement as HTMLElement;
    expect(html.querySelector('.trips-cards')).not.toBeNull();
    expect(html.querySelector('.trips-table')).toBeNull();
    expect(html.querySelectorAll('.trips-card')).toHaveLength(2);
    expect(html.textContent).toContain('Oaxaca Mágica');
  });

  describe('for a viewer west of UTC', () => {
    // The API serializes `departure_date` (a @db.Date) as midnight UTC; the
    // list must show that calendar day, not the day before. The suite runs in
    // America/Mexico_City (UTC-6), pinned in jest.config.cts.

    it('shows the departure date as stored in the table layout', () => {
      configure();
      const fixture = TestBed.createComponent(TripsListComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Nov 1, 2026');
      expect(text).toContain('Dec 1, 2026');
    });

    it('shows the departure date as stored in the handset card layout', () => {
      configureHandset();
      const fixture = TestBed.createComponent(TripsListComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/trips').flush(trips);
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).querySelector('.trips-cards')!.textContent ?? '';
      expect(text).toContain('Nov 1, 2026');
      expect(text).toContain('Dec 1, 2026');
    });
  });
});
