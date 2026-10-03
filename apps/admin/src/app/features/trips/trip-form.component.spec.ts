import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNativeDateAdapter } from '@angular/material/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { TripFormComponent } from './trip-form.component';

function tripFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    translations: [
      { locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
    ],
    images: [],
    ...overrides,
  };
}

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

/**
 * Builds the TestBed for a given route param map, mirroring
 * `RoleFormComponent`'s and `StaffFormComponent`'s spec setup: `TripFormComponent`
 * reads `tripId` off `ActivatedRoute.paramMap` reactively, so a test simulates
 * Angular's route-reuse strategy by pushing a new value onto this subject
 * rather than recreating the component.
 */
function configure(initialParams: Record<string, string> = {}): BehaviorSubject<ParamMap> {
  const paramMap$ = new BehaviorSubject(convertToParamMap(initialParams));
  TestBed.configureTestingModule({
    imports: [TripFormComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'trips', children: [] }]),
      provideNoopAnimations(),
      provideNativeDateAdapter(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(initialParams) }, paramMap: paramMap$ },
      },
    ],
  });
  return paramMap$;
}

describe('TripFormComponent', () => {
  describe('cross-field validation', () => {
    beforeEach(() => configure());

    it('flags a return date earlier than the departure date', () => {
      const fixture = TestBed.createComponent(TripFormComponent);
      const { form } = fixture.componentInstance;
      form.patchValue({ departureDate: new Date('2026-11-10'), returnDate: new Date('2026-11-01') });

      expect(form.hasError('returnBeforeDeparture')).toBe(true);
    });

    it('flags a payment deadline after the departure date', () => {
      const fixture = TestBed.createComponent(TripFormComponent);
      const { form } = fixture.componentInstance;
      form.patchValue({ departureDate: new Date('2026-11-10'), paymentDeadline: new Date('2026-11-20') });

      expect(form.hasError('paymentAfterDeparture')).toBe(true);
    });

    it('flags pre-sold seats above total capacity', () => {
      const fixture = TestBed.createComponent(TripFormComponent);
      const { form } = fixture.componentInstance;
      form.patchValue({ totalCapacity: 10, preSoldSeats: 11 });

      expect(form.hasError('preSoldExceedsCapacity')).toBe(true);
    });

    it('reports no cross-field error for a consistent set of dates and seats', () => {
      const fixture = TestBed.createComponent(TripFormComponent);
      const { form } = fixture.componentInstance;
      form.patchValue({
        departureDate: new Date('2026-11-10'),
        returnDate: new Date('2026-11-17'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 10,
        preSoldSeats: 5,
      });

      expect(form.hasError('returnBeforeDeparture')).toBe(false);
      expect(form.hasError('paymentAfterDeparture')).toBe(false);
      expect(form.hasError('preSoldExceedsCapacity')).toBe(false);
    });
  });

  describe('reactive route params', () => {
    it('re-fetches and resets the form when navigating from one trip id straight to another', async () => {
      const paramMap$ = configure({ tripId: 'trip-1' });
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();

      const httpMock = TestBed.inject(HttpTestingController);
      httpMock.expectOne('/api/v1/trips/trip-1').flush(tripFixture({ id: 'trip-1' }));

      expect(fixture.componentInstance.form.controls.nameEs.value).toBe('Oaxaca Mágica');

      // Route reuse: same component instance, new id. The `effect()` that
      // reacts to it is scheduled, not synchronous, so a change-detection
      // pass (and letting microtasks settle) is what actually runs it here.
      paramMap$.next(convertToParamMap({ tripId: 'trip-2' }));
      fixture.detectChanges();
      await fixture.whenStable();

      // The form must already show the reset shape, not trip-1's stale data,
      // even before trip-2's response arrives.
      expect(fixture.componentInstance.form.controls.nameEs.value).toBe('');

      const secondRequest = httpMock.expectOne('/api/v1/trips/trip-2');
      secondRequest.flush(
        tripFixture({
          id: 'trip-2',
          translations: [
            { locale: 'es', name: 'Chiapas Profundo', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
          ],
        })
      );

      expect(fixture.componentInstance.form.controls.nameEs.value).toBe('Chiapas Profundo');
    });

    it('ignores a stale response for a trip id the route has already left', async () => {
      const paramMap$ = configure({ tripId: 'trip-1' });
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();

      const httpMock = TestBed.inject(HttpTestingController);
      const firstRequest = httpMock.expectOne('/api/v1/trips/trip-1');

      // Navigate away before trip-1's request resolves.
      paramMap$.next(convertToParamMap({ tripId: 'trip-2' }));
      fixture.detectChanges();
      await fixture.whenStable();
      httpMock.expectOne('/api/v1/trips/trip-2').flush(tripFixture({ id: 'trip-2' }));

      // The late trip-1 response must not clobber trip-2's already-loaded data.
      firstRequest.flush(tripFixture({ id: 'trip-1' }));

      expect(fixture.componentInstance.trip()?.id).toBe('trip-2');
    });
  });

  describe('hot-start section', () => {
    it('is hidden from a user without data.backfill', () => {
      configure();
      const auth = TestBed.inject(AuthService);
      auth.setSessionForTesting('access', userWith(['trip.create']));

      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).innerHTML).not.toContain('backfillCheckbox');
    });
  });

  describe('publish gating', () => {
    it('names both missing requirements when a draft trip has no images and no price', () => {
      const configuredParams = configure({ tripId: 'trip-1' });
      void configuredParams;
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController)
        .expectOne('/api/v1/trips/trip-1')
        .flush(tripFixture({ images: [], pricePerSeatCents: 0 }));

      expect(fixture.componentInstance.publishBlockedReasons()).toEqual([
        'trips.publishMissingImages',
        'trips.publishMissingPrice',
      ]);
    });

    it('reports nothing missing once the trip has an image and a positive price', () => {
      configure({ tripId: 'trip-1' });
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController)
        .expectOne('/api/v1/trips/trip-1')
        .flush(
          tripFixture({
            images: [{ id: 'img-1', storageKey: 'k', position: 0, isCover: true, altText: null }],
            pricePerSeatCents: 174_000,
          })
        );

      expect(fixture.componentInstance.publishBlockedReasons()).toEqual([]);
    });
  });

  describe('status transitions', () => {
    it('only offers legal transitions for the trip current status', () => {
      configure({ tripId: 'trip-1' });
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/trips/trip-1').flush(tripFixture({ status: 'PUBLISHED' }));

      expect(fixture.componentInstance.availableTransitions()).toEqual(['IN_PROGRESS', 'CANCELLED']);
    });

    it('offers no transitions for a terminal status', () => {
      configure({ tripId: 'trip-1' });
      const fixture = TestBed.createComponent(TripFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/trips/trip-1').flush(tripFixture({ status: 'COMPLETED' }));

      expect(fixture.componentInstance.availableTransitions()).toEqual([]);
    });
  });

  describe('server-side error mapping', () => {
    it('lands a VALIDATION_FAILED response for totalCapacity on the matching control', () => {
      configure();
      const fixture = TestBed.createComponent(TripFormComponent);
      const { form } = fixture.componentInstance;
      form.patchValue({
        departureDate: new Date('2026-11-10'),
        returnDate: new Date('2026-11-17'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 10,
        nameEs: 'Trip',
        descriptionEs: 'd',
        itineraryEs: 'i',
        includesEs: 'inc',
        excludesEs: 'exc',
      });

      fixture.componentInstance.save();

      TestBed.inject(HttpTestingController)
        .expectOne('/api/v1/trips')
        .flush({ code: 'INVALID_CAPACITY', details: { field: 'totalCapacity' } }, { status: 422, statusText: 'Unprocessable' });

      expect(form.controls.totalCapacity.hasError('server')).toBe(true);
    });
  });
});
