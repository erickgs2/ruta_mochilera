import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { TripImagesComponent } from './trip-images.component';

const trip = {
  id: 'trip-1',
  slug: 'oaxaca-2026',
  status: 'DRAFT',
  departureDate: '2026-11-01T00:00:00.000Z',
  returnDate: '2026-11-08T00:00:00.000Z',
  paymentDeadline: '2026-10-25T00:00:00.000Z',
  totalCapacity: 20,
  preSoldSeats: 0,
  availableSeats: 20,
  holdTtlHours: 72,
  minimumDepositCents: 50_000,
  budgetTotalCents: 0,
  marginMode: 'PERCENTAGE',
  marginValue: 0,
  pricePerSeatCents: 0,
  priceMode: 'AUTO',
  publishedAt: null,
  isBackfilled: false,
  translations: [{ locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' }],
  images: [] as { id: string; storageKey: string; position: number; isCover: boolean; altText: string | null; url: string }[],
};

let dialogOpen: jest.Mock;

function configure(): void {
  dialogOpen = jest.fn().mockReturnValue({ afterClosed: () => of(true) });
  TestBed.configureTestingModule({
    imports: [TripImagesComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: MatDialog, useValue: { open: dialogOpen } },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: convertToParamMap({ tripId: 'trip-1' }) },
          paramMap: of(convertToParamMap({ tripId: 'trip-1' })),
        },
      },
    ],
  });
}

function fileOf(name: string): File {
  return new File([new Uint8Array(10)], name, { type: 'image/png' });
}

describe('TripImagesComponent', () => {
  it('loads the trip and maps its images to gallery entries, using the URL the API already computed', () => {
    // The server (not this component) is responsible for turning a
    // `storageKey` into a URL, since that mapping differs completely between
    // the `local` and `s3` storage drivers -- see `withImageUrls` in
    // `apps/api/src/lib/http/trip-response.ts`. This asserts the component
    // passes `image.url` straight through rather than reconstructing one.
    configure();
    const fixture = TestBed.createComponent(TripImagesComponent);
    fixture.detectChanges();

    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/trips/trip-1')
      .flush({
        ...trip,
        images: [
          { id: 'img-1', storageKey: 'trips/trip-1/a.jpg', position: 0, isCover: true, altText: null, url: 'https://cdn.example.test/trips/trip-1/a.jpg' },
        ],
      });

    expect(fixture.componentInstance.images()).toEqual([
      { id: 'img-1', url: 'https://cdn.example.test/trips/trip-1/a.jpg', isCover: true, altText: null },
    ]);
  });

  it('uploads files one at a time so the first one picked becomes the cover', () => {
    configure();
    const fixture = TestBed.createComponent(TripImagesComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/trips/trip-1').flush(trip);

    const firstFile = fileOf('first.png');
    const secondFile = fileOf('second.png');
    fixture.componentInstance.onFilesSelected([firstFile, secondFile]);

    // Only the first upload request should exist until it resolves --
    // `concatMap` must not fire the second upload before the first completes.
    httpMock.expectNone((req) => req.url === '/api/v1/trips/trip-1/images' && req.body?.get?.('file') === secondFile);
    const firstRequest = httpMock.expectOne('/api/v1/trips/trip-1/images');
    firstRequest.flush({ id: 'img-1', tripId: 'trip-1', storageKey: 'k1', position: 0, isCover: true, altText: null, url: '/api/v1/files/k1' });

    const secondRequest = httpMock.expectOne('/api/v1/trips/trip-1/images');
    secondRequest.flush({ id: 'img-2', tripId: 'trip-1', storageKey: 'k2', position: 1, isCover: false, altText: null, url: '/api/v1/files/k2' });

    expect(fixture.componentInstance.images()).toEqual([
      { id: 'img-1', url: '/api/v1/files/k1', isCover: true, altText: null },
      { id: 'img-2', url: '/api/v1/files/k2', isCover: false, altText: null },
    ]);
  });

  it('asks for confirmation before deleting, then reloads the gallery from the trip', () => {
    configure();
    const fixture = TestBed.createComponent(TripImagesComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock
      .expectOne('/api/v1/trips/trip-1')
      .flush({ ...trip, images: [{ id: 'img-1', storageKey: 'k1', position: 0, isCover: true, altText: null, url: '/api/v1/files/k1' }] });

    fixture.componentInstance.onDeleteRequested('img-1');
    expect(dialogOpen).toHaveBeenCalled();

    const deleteRequest = httpMock.expectOne('/api/v1/trips/trip-1/images/img-1');
    expect(deleteRequest.request.method).toBe('DELETE');
    deleteRequest.flush(null);

    // Promoting the new cover happens server-side with no body in the
    // response (see the class doc comment), so the component must reload.
    const reloadRequest = httpMock.expectOne('/api/v1/trips/trip-1');
    reloadRequest.flush({ ...trip, images: [] });

    expect(fixture.componentInstance.images()).toEqual([]);
  });
});
