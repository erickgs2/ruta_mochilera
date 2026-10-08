import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { CounterReservationComponent } from './counter-reservation.component';
import { staffWith, testProviders } from './customers.spec-helpers';

const trips = [
  { slug: 'oaxaca-2027', name: 'Oaxaca', departureDate: '2027-03-01T00:00:00.000Z', returnDate: '2027-03-07T00:00:00.000Z', pricePerSeatCents: 500_000, availableSeats: 4, images: [] },
];

function configure(permissions: string[]) {
  const setup = testProviders();
  TestBed.configureTestingModule({ imports: [CounterReservationComponent], providers: setup.providers });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(permissions));
  const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(CounterReservationComponent);
  fixture.componentRef.setInput('customerId', 'cust-1');
  fixture.componentRef.setInput('customerName', 'María Peña');
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  httpMock.expectOne('/api/v1/public/trips').flush(trips);
  fixture.detectChanges();
  return { fixture, httpMock, navigate };
}

function resolveTrip(httpMock: HttpTestingController) {
  httpMock.expectOne('/api/v1/public/trips/oaxaca-2027').flush({ id: 'trip-1', slug: 'oaxaca-2027' });
}

describe('CounterReservationComponent', () => {
  afterEach(() => localStorage.clear());

  it('reserves and takes cash in one step by default', () => {
    const { fixture, httpMock, navigate } = configure(['reservation.create', 'payment.register']);
    fixture.componentInstance.form.setValue({ tripSlug: 'oaxaca-2027', mode: 'payment', amountCents: 150_000 });

    fixture.componentInstance.submit();
    resolveTrip(httpMock);
    const request = httpMock.expectOne('/api/v1/admin/reservations');
    expect(request.request.body).toEqual({ tripId: 'trip-1', customerId: 'cust-1', initialPaymentCents: 150_000 });
    request.flush({ id: 'res-1', code: 'RM-AAAA-BBBB' });

    expect(navigate).toHaveBeenCalledWith(['/reservations', 'res-1']);
  });

  it('holds without payment when chosen', () => {
    const { fixture, httpMock } = configure(['reservation.create', 'payment.register']);
    fixture.componentInstance.form.setValue({ tripSlug: 'oaxaca-2027', mode: 'hold', amountCents: 150_000 });

    fixture.componentInstance.submit();
    resolveTrip(httpMock);

    expect(httpMock.expectOne('/api/v1/admin/reservations').request.body).toEqual({ tripId: 'trip-1', customerId: 'cust-1' });
  });

  it('only holds, and offers no payment, without payment.register', () => {
    const { fixture, httpMock } = configure(['reservation.create']);
    expect(fixture.nativeElement.querySelector('mat-radio-group')).toBeNull();
    fixture.componentInstance.form.controls.tripSlug.setValue('oaxaca-2027');

    fixture.componentInstance.submit();
    resolveTrip(httpMock);

    expect(httpMock.expectOne('/api/v1/admin/reservations').request.body).toEqual({ tripId: 'trip-1', customerId: 'cust-1' });
  });

  it('asks for an amount before reserving with payment', () => {
    const { fixture, httpMock } = configure(['reservation.create', 'payment.register']);
    fixture.componentInstance.form.setValue({ tripSlug: 'oaxaca-2027', mode: 'payment', amountCents: 0 });

    fixture.componentInstance.submit();

    httpMock.expectNone('/api/v1/public/trips/oaxaca-2027');
  });
});

describe('CounterReservationComponent calendar days (America/Mexico_City)', () => {
  afterEach(() => {
    localStorage.clear();
    document.querySelectorAll('.cdk-overlay-container').forEach((overlay) => (overlay.innerHTML = ''));
  });

  it('lists each trip with its departure as the stored day, not the day before', () => {
    localStorage.setItem('rm.locale', 'es');
    const { fixture } = configure(['reservation.create']);

    (fixture.nativeElement.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();

    const option = document.querySelector('mat-option')?.textContent;
    expect(option).toContain('1 mar 2027');
    expect(option).not.toContain('28 feb 2027');
  });
});
