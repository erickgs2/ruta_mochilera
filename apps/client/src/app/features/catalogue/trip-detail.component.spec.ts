import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL, type components } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { TripDetailComponent } from './trip-detail.component';

type PublicTripDetail = components['schemas']['PublicTripDetail'];

function detail(overrides: Partial<PublicTripDetail> = {}): PublicTripDetail {
  return {
    slug: 'oaxaca-magica',
    departureDate: '2026-11-20T00:00:00.000Z',
    returnDate: '2026-11-24T00:00:00.000Z',
    pricePerSeatCents: 850_000,
    availableSeats: 12,
    translations: [
      {
        locale: 'es',
        name: 'Oaxaca Mágica',
        description: 'Cuatro días en Oaxaca',
        itinerary: 'Día 1: llegada',
        includes: 'Hospedaje',
        excludes: 'Vuelos',
      },
      {
        locale: 'en',
        name: 'Magic Oaxaca',
        description: 'Four days in Oaxaca',
        itinerary: 'Day 1: arrival',
        includes: 'Lodging',
        excludes: 'Flights',
      },
    ],
    images: [],
    ...overrides,
  };
}

async function open(slug: string) {
  localStorage.clear();
  // `LanguageService` otherwise falls back to `navigator.language`, which is
  // `en-US` under jsdom.
  localStorage.setItem('rm.locale', 'es');
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips/:slug', component: TripDetailComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations(['catalogue.soldOut', 'catalogue.reserve', 'catalogue.notFound', 'errors.UNKNOWN'])
  );
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/trips/${slug}`);
  return { harness, http: TestBed.inject(HttpTestingController) };
}

describe('TripDetailComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders the trip in the active language with a reserve button', async () => {
    const { harness, http } = await open('oaxaca-magica');

    http.expectOne('/api/v1/public/trips/oaxaca-magica').flush(detail());
    harness.detectChanges();

    const text: string = harness.routeNativeElement!.textContent ?? '';
    expect(text).toContain('Oaxaca Mágica');
    expect(text).toContain('Cuatro días en Oaxaca');
    expect(text).not.toContain('Magic Oaxaca');
    expect(harness.routeNativeElement!.querySelector('.trip-reserve')).not.toBeNull();
  });

  it('shows a sold-out trip as sold out, with no reserve button', async () => {
    const { harness, http } = await open('oaxaca-magica');

    http.expectOne('/api/v1/public/trips/oaxaca-magica').flush(detail({ availableSeats: 0 }));
    harness.detectChanges();

    expect(harness.routeNativeElement!.textContent).toContain(shown('catalogue.soldOut'));
    expect(harness.routeNativeElement!.querySelector('.trip-reserve')).toBeNull();
  });

  it('shows the not-found state for a slug that does not exist, not a blank screen', async () => {
    const { harness, http } = await open('no-such-trip');

    http
      .expectOne('/api/v1/public/trips/no-such-trip')
      .flush({ code: 'NOT_FOUND', title: 'Not Found', status: 404 }, { status: 404, statusText: 'Not Found' });
    harness.detectChanges();

    const element = harness.routeNativeElement!;
    expect(element.querySelector('.trip-not-found')).not.toBeNull();
    expect(element.textContent).toContain(shown('catalogue.notFound'));
    expect(element.querySelector('.trip-reserve')).toBeNull();
  });

  it('shows the generic error, not the raw code, for any other failure', async () => {
    const { harness, http } = await open('oaxaca-magica');

    http
      .expectOne('/api/v1/public/trips/oaxaca-magica')
      .flush({ code: 'SOMETHING_ODD', title: 'Backend text' }, { status: 500, statusText: 'Server Error' });
    harness.detectChanges();

    const text: string = harness.routeNativeElement!.textContent ?? '';
    expect(text).toContain(shown('errors.UNKNOWN'));
    expect(text).not.toContain('SOMETHING_ODD');
    expect(text).not.toContain('Backend text');
  });

  describe('for a visitor west of UTC', () => {
    // The API serializes a @db.Date column as midnight UTC. A calendar date
    // must render as that day everywhere, not shift to the day before. The
    // suite runs in America/Mexico_City (UTC-6), pinned in jest.config.cts.

    it('shows the departure and return dates as stored, without shifting them a day', async () => {
      const { harness, http } = await open('oaxaca-magica');

      http.expectOne('/api/v1/public/trips/oaxaca-magica').flush(detail());
      harness.detectChanges();

      const dates: string = harness.routeNativeElement!.querySelector('.trip-dates')!.textContent ?? '';
      expect(dates).toContain('Nov 20, 2026');
      expect(dates).toContain('Nov 24, 2026');
    });
  });
});
