import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '@rm/auth-web';
import { staffWith, testProviders } from '../customers/customers.spec-helpers';
import { TripPriceChangeComponent } from './trip-price-change.component';

const URL = '/api/v1/trips/trip-1/price-change';
const preview = {
  tripId: 'trip-1',
  priceCents: 400_000,
  reservations: [
    { reservationId: 'r1', code: 'RM-1', customerName: 'Ana', status: 'ACTIVE', previousTotalCents: 500_000, newTotalCents: 400_000, paidCents: 450_000, newBalanceCents: 0, creditCents: 50_000 },
  ],
};

function configure(dialogResult = true) {
  const setup = testProviders(dialogResult);
  TestBed.configureTestingModule({
    imports: [TripPriceChangeComponent],
    providers: [...setup.providers, { provide: ActivatedRoute, useValue: { params: of({ tripId: 'trip-1' }) } }],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['trip.view', 'trip.change_price']));
  const fixture = TestBed.createComponent(TripPriceChangeComponent);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController), dialogOpen: setup.dialogOpen };
}

describe('TripPriceChangeComponent', () => {
  afterEach(() => localStorage.clear());

  it('shows the preview, with the credit a lower price creates, before anything is applied', () => {
    const { fixture, httpMock } = configure();
    httpMock.expectOne(URL).flush(preview);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.price-table tr.mat-mdc-row')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.price-credit').textContent).toContain('500.00');
    httpMock.expectNone((req) => req.method === 'POST');
  });

  it('requires the Spanish notice, then confirms and applies', () => {
    const { fixture, httpMock, dialogOpen } = configure();
    httpMock.expectOne(URL).flush(preview);
    fixture.detectChanges();

    fixture.componentInstance.apply();
    expect(dialogOpen).not.toHaveBeenCalled();

    fixture.componentInstance.form.setValue({ noticeEs: 'Bajó el transporte.', noticeEn: '' });
    fixture.componentInstance.apply();
    const request = httpMock.expectOne((req) => req.method === 'POST' && req.url === URL);
    expect(request.request.body).toEqual({ noticeEs: 'Bajó el transporte.' });
    request.flush(preview);
    httpMock.expectOne(URL).flush({ code: 'NO_PRICE_CHANGE' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.price-nothing')).not.toBeNull();
  });

  it('says there is nothing to do when every reservation already has the price', () => {
    const { fixture, httpMock } = configure();
    httpMock.expectOne(URL).flush({ code: 'NO_PRICE_CHANGE' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.price-nothing')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.price-form')).toBeNull();
  });
});
