import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL, type components } from '@rm/api-client';
import { authInterceptor } from '@rm/auth-web';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { TripListComponent } from './trip-list.component';

type PublicTripSummary = components['schemas']['PublicTripSummary'];

function trip(overrides: Partial<PublicTripSummary>): PublicTripSummary {
  return {
    slug: 'oaxaca-magica',
    name: 'Oaxaca Mágica',
    departureDate: '2026-11-20T00:00:00.000Z',
    returnDate: '2026-11-24T00:00:00.000Z',
    pricePerSeatCents: 850_000,
    availableSeats: 12,
    images: [],
    ...overrides,
  };
}

function setup() {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [TripListComponent],
    providers: [
      // The real interceptor, not a bare HttpClient: the point of the first
      // test is that an anonymous visitor's request goes out with no token.
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations(['catalogue.soldOut', 'catalogue.reserve', 'catalogue.empty', 'errors.UNKNOWN'])
  );
  const fixture = TestBed.createComponent(TripListComponent);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

describe('TripListComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('requests the public catalogue without a token and renders one card per trip', () => {
    const { fixture, http } = setup();

    const request = http.expectOne('/api/v1/public/trips');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush([trip({ slug: 'a', name: 'Oaxaca' }), trip({ slug: 'b', name: 'Chiapas' })]);
    fixture.detectChanges();

    const cards = fixture.nativeElement.querySelectorAll('.trip-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Oaxaca');
    expect(cards[1].textContent).toContain('Chiapas');
  });

  it('shows a trip with no seats left as sold out, with no reserve button', () => {
    const { fixture, http } = setup();

    http.expectOne('/api/v1/public/trips').flush([trip({ slug: 'full', availableSeats: 0 })]);
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.trip-card');
    expect(card.textContent).toContain(shown('catalogue.soldOut'));
    expect(card.querySelector('.trip-reserve')).toBeNull();
  });

  it('shows the reserve button on a trip that still has seats', () => {
    const { fixture, http } = setup();

    http.expectOne('/api/v1/public/trips').flush([trip({ slug: 'open', availableSeats: 3 })]);
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.trip-card');
    expect(card.querySelector('.trip-reserve')).not.toBeNull();
    expect(card.textContent).not.toContain(shown('catalogue.soldOut'));
  });

  it('shows the empty state when no trip is published', () => {
    const { fixture, http } = setup();

    http.expectOne('/api/v1/public/trips').flush([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('catalogue.empty'));
  });

  it('shows the translated generic error, not the raw code, when loading fails', () => {
    const { fixture, http } = setup();

    http
      .expectOne('/api/v1/public/trips')
      .flush({ code: 'SOMETHING_ODD', title: 'Backend text' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain(shown('errors.UNKNOWN'));
    expect(text).not.toContain('SOMETHING_ODD');
    expect(text).not.toContain('Backend text');
  });

  describe('for a visitor west of UTC', () => {
    // The API serializes a @db.Date column as midnight UTC. A calendar date
    // must render as that day everywhere, not shift to the day before. The
    // suite runs in America/Mexico_City (UTC-6), pinned in jest.config.cts.

    it('shows the departure and return dates as stored, without shifting them a day', () => {
      const { fixture, http } = setup();

      http.expectOne('/api/v1/public/trips').flush([trip({})]);
      fixture.detectChanges();

      const dates: string = fixture.nativeElement.querySelector('.trip-dates').textContent;
      expect(dates).toContain('Nov 20, 2026');
      expect(dates).toContain('Nov 24, 2026');
    });
  });
});
