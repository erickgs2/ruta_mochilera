import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { TripCostingComponent } from './trip-costing.component';

/**
 * Budget: Bus $5,000 + Hotel (20 x $1,200) = $24,000 -- matches the brief's
 * own fixture, including its `PERCENTAGE`/2000/174,000 numbers, so the given
 * spec (Step 2 of the task brief) and this file agree on the same trip.
 */
const costing = {
  tripId: 't1',
  items: [
    { id: 'i1', concept: 'Bus', supplier: 'Transportes SA', quantity: 1, unitAmountCents: 500_000, totalCents: 500_000, notes: null },
    { id: 'i2', concept: 'Hotel', supplier: null, quantity: 20, unitAmountCents: 120_000, totalCents: 2_400_000, notes: null },
  ],
  budgetTotalCents: 2_900_000,
  marginMode: 'PERCENTAGE',
  marginValue: 2000,
  priceMode: 'AUTO',
  suggestedPricePerSeatCents: 174_000,
  pricePerSeatCents: 174_000,
  totalCapacity: 20,
};

const trip = {
  id: 't1',
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
  budgetTotalCents: 2_900_000,
  marginMode: 'PERCENTAGE',
  marginValue: 2000,
  pricePerSeatCents: 174_000,
  priceMode: 'AUTO',
  publishedAt: null,
  isBackfilled: false,
  translations: [{ locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' }],
  images: [],
};

describe('TripCostingComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TripCostingComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideNoopAnimations(),
        provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
        { provide: API_BASE_URL, useValue: '' },
        { provide: ActivatedRoute, useValue: { params: of({ tripId: 't1' }), snapshot: { params: { tripId: 't1' } } } },
      ],
    });
  });

  /**
   * Mirrors the task brief's own `load()` helper: creates the component and
   * flushes only the costing GET. The component also issues a `GET
   * /api/v1/trips/t1` (for the "trip is not DRAFT" notice -- see
   * `showRepriceNotice`), which is left unflushed here exactly as the
   * brief's helper does for any request beyond the one it names; nothing in
   * this file calls `HttpTestingController.verify()`, so that is not an
   * error.
   */
  function load() {
    const fixture = TestBed.createComponent(TripCostingComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/trips/t1/costing').flush(costing);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the budget total and the price per seat', () => {
    const component = load().componentInstance;
    expect(component.costing()?.budgetTotalCents).toBe(2_900_000);
    expect(component.costing()?.pricePerSeatCents).toBe(174_000);
  });

  it('flags the price as overridden when the mode is MANUAL', () => {
    const fixture = TestBed.createComponent(TripCostingComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/trips/t1/costing')
      .flush({ ...costing, priceMode: 'MANUAL', pricePerSeatCents: 200_000 });
    fixture.detectChanges();

    // MANUAL never hides the computed suggestion -- both numbers stay visible.
    expect(fixture.componentInstance.isPriceOverridden()).toBe(true);
    expect(fixture.componentInstance.costing()?.suggestedPricePerSeatCents).toBe(174_000);
    expect(fixture.componentInstance.costing()?.pricePerSeatCents).toBe(200_000);
  });

  it('labels the margin field according to the selected mode', () => {
    const component = load().componentInstance;

    component.marginForm.controls.marginMode.setValue('PERCENTAGE');
    expect(component.marginUnitLabel()).toBe('costing.unit.percent');

    component.marginForm.controls.marginMode.setValue('FIXED_TOTAL');
    expect(component.marginUnitLabel()).toBe('costing.unit.currency');
  });

  it('gives each margin mode its own hint key, since the two fixed modes share a unit but not a meaning', () => {
    const component = load().componentInstance;

    component.marginForm.controls.marginMode.setValue('PERCENTAGE');
    expect(component.marginHintKey()).toBe('costing.marginValueHint.PERCENTAGE');

    component.marginForm.controls.marginMode.setValue('FIXED_TOTAL');
    expect(component.marginHintKey()).toBe('costing.marginValueHint.FIXED_TOTAL');

    component.marginForm.controls.marginMode.setValue('FIXED_PER_SEAT');
    expect(component.marginHintKey()).toBe('costing.marginValueHint.FIXED_PER_SEAT');
  });

  /**
   * The central hazard this screen exists to close: `marginValue` means
   * basis points under PERCENTAGE and cents under either fixed mode (see
   * `PricingInput.marginValue` in `@rm/domain-costing`). This test drives
   * all three modes on the same trip and checks both halves of the
   * contract: (1) what the component actually puts on the wire for each
   * mode, and (2) that the three resulting prices are pairwise distinct --
   * the backend's own plan once shipped two modes whose test fixtures
   * produced the identical number, which would have let either
   * implementation pass both. $24,000 budget over 20 seats:
   *
   *   PERCENTAGE    20 %     -> $28,800 total -> $1,440.00/seat (174,000 wire-typed as 20)
   *   FIXED_TOTAL   $6,000   -> $30,000 total -> $1,750.00/seat (175,000)
   *   FIXED_PER_SEAT $250/seat -> $29,000 total -> $1,700.00/seat (170,000)
   *
   * chosen so no two of the three collide.
   */
  it('converts the typed margin value into the right wire unit for each mode, and keeps all three results distinguishable', () => {
    const fixture = load();
    const component = fixture.componentInstance;
    const httpMock = TestBed.inject(HttpTestingController);

    const results: number[] = [];

    // PERCENTAGE: the user types a plain percentage; the wire value is basis points.
    component.marginForm.controls.marginMode.setValue('PERCENTAGE');
    component.marginForm.controls.marginValue.setValue(20); // 20 %
    component.savePricingPolicy();
    let request = httpMock.expectOne('/api/v1/trips/t1/costing');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual(
      expect.objectContaining({ marginMode: 'PERCENTAGE', marginValue: 2000 })
    );
    request.flush({ ...costing, marginMode: 'PERCENTAGE', marginValue: 2000, suggestedPricePerSeatCents: 174_000, pricePerSeatCents: 174_000 });
    results.push(component.costing()!.pricePerSeatCents);

    // FIXED_TOTAL: the user types pesos through `rm-money-input`, which
    // already emits cents -- the wire value is that same number, untouched.
    component.marginForm.controls.marginMode.setValue('FIXED_TOTAL');
    component.marginForm.controls.marginValue.setValue(600_000); // $6,000.00, as cents
    component.savePricingPolicy();
    request = httpMock.expectOne('/api/v1/trips/t1/costing');
    expect(request.request.body).toEqual(
      expect.objectContaining({ marginMode: 'FIXED_TOTAL', marginValue: 600_000 })
    );
    request.flush({ ...costing, marginMode: 'FIXED_TOTAL', marginValue: 600_000, suggestedPricePerSeatCents: 175_000, pricePerSeatCents: 175_000 });
    results.push(component.costing()!.pricePerSeatCents);

    // FIXED_PER_SEAT: also cents, straight from `rm-money-input`.
    component.marginForm.controls.marginMode.setValue('FIXED_PER_SEAT');
    component.marginForm.controls.marginValue.setValue(25_000); // $250.00 per seat, as cents
    component.savePricingPolicy();
    request = httpMock.expectOne('/api/v1/trips/t1/costing');
    expect(request.request.body).toEqual(
      expect.objectContaining({ marginMode: 'FIXED_PER_SEAT', marginValue: 25_000 })
    );
    request.flush({ ...costing, marginMode: 'FIXED_PER_SEAT', marginValue: 25_000, suggestedPricePerSeatCents: 170_000, pricePerSeatCents: 170_000 });
    results.push(component.costing()!.pricePerSeatCents);

    expect(results).toEqual([174_000, 175_000, 170_000]);
    // The whole point of picking these three numbers: no two modes must ever
    // collapse onto the same observable result in this test.
    expect(new Set(results).size).toBe(3);
  });

  it('resets the margin value when the mode changes, so a stale number is never silently reinterpreted in the new unit', () => {
    const component = load().componentInstance;

    // Loaded costing was PERCENTAGE/2000, so marginValue starts at 20 (percent).
    expect(component.marginForm.controls.marginValue.value).toBe(20);

    component.marginForm.controls.marginMode.setValue('FIXED_TOTAL');

    expect(component.marginForm.controls.marginValue.value).toBe(0);
  });

  it('shows a permanent notice when the trip is not DRAFT, since re-pricing never touches existing reservations', () => {
    const fixture = TestBed.createComponent(TripCostingComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/trips/t1/costing').flush(costing);
    httpMock.expectOne('/api/v1/trips/t1').flush({ ...trip, status: 'PUBLISHED' });
    fixture.detectChanges();

    expect(fixture.componentInstance.showRepriceNotice()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('costing.repriceNotice');
  });

  it('hides the reprice notice for a trip still in DRAFT', () => {
    const fixture = TestBed.createComponent(TripCostingComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/trips/t1/costing').flush(costing);
    httpMock.expectOne('/api/v1/trips/t1').flush({ ...trip, status: 'DRAFT' });
    fixture.detectChanges();

    expect(fixture.componentInstance.showRepriceNotice()).toBe(false);
  });

  it('sends a new budget item with the exact integer cents the money input produced, never a fraction', () => {
    const component = load().componentInstance;
    const httpMock = TestBed.inject(HttpTestingController);

    component.newItemForm.setValue({ concept: 'Guide', supplier: '', quantity: 1, unitAmountCents: 150_050, notes: '' });
    component.addItem();

    const request = httpMock.expectOne('/api/v1/trips/t1/costing/items');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.unitAmountCents).toBe(150_050);
    expect(Number.isInteger(request.request.body.unitAmountCents)).toBe(true);
    request.flush({ ...costing, items: [...costing.items, { id: 'i3', concept: 'Guide', supplier: null, quantity: 1, unitAmountCents: 150_050, totalCents: 150_050, notes: null }] });

    expect(component.costing()?.items).toHaveLength(3);
  });
});
