import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { CustomerBackfillComponent } from './customer-backfill.component';
import { staffWith, testProviders } from './customers.spec-helpers';

const trips = [
  { id: 't-done', slug: 'a', status: 'COMPLETED', name: 'Oaxaca 2025', departureDate: '2025-03-01T00:00:00.000Z', totalCapacity: 20, availableSeats: 3, pricePerSeatCents: 500_000 },
  { id: 't-draft', slug: 'b', status: 'DRAFT', name: 'Borrador', departureDate: '2027-03-01T00:00:00.000Z', totalCapacity: 20, availableSeats: 20, pricePerSeatCents: 0 },
];

function configure() {
  const setup = testProviders();
  TestBed.configureTestingModule({ imports: [CustomerBackfillComponent], providers: setup.providers });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['data.backfill', 'trip.view']));
  const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(CustomerBackfillComponent);
  fixture.componentRef.setInput('customerId', 'cust-1');
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  httpMock.expectOne('/api/v1/trips').flush(trips);
  fixture.detectChanges();
  return { fixture, httpMock, navigate };
}

describe('CustomerBackfillComponent', () => {
  afterEach(() => localStorage.clear());

  it('offers finished trips but never drafts or cancelled ones', () => {
    const { fixture } = configure();

    expect(fixture.componentInstance.trips().map((trip) => trip.id)).toEqual(['t-done']);
  });

  it('keeps receipts silent by default and sends dates as noon of the chosen day', () => {
    const { fixture, httpMock, navigate } = configure();
    const component = fixture.componentInstance;
    expect(component.form.controls.sendReceipts.value).toBe(false);

    component.form.patchValue({ tripId: 't-done', createdAt: '2025-01-10' });
    component.addPayment();
    component.payments.at(0).setValue({ amountCents: 150_000, paidAt: '2025-01-10', method: 'CASH', notes: 'Libreta 3' });
    component.submit();

    const request = httpMock.expectOne('/api/v1/admin/backfill/reservations');
    expect(request.request.body).toMatchObject({
      tripId: 't-done',
      customerId: 'cust-1',
      sendReceipts: false,
      payments: [{ amountCents: 150_000, method: 'CASH', notes: 'Libreta 3' }],
    });
    expect(new Date(request.request.body.createdAt).getHours()).toBe(12);
    request.flush({ id: 'res-9', code: 'RM-9' });
    expect(navigate).toHaveBeenCalledWith(['/reservations', 'res-9']);
  });

  it('refuses a date in the future', () => {
    const { fixture, httpMock } = configure();
    fixture.componentInstance.form.patchValue({ tripId: 't-done', createdAt: '2999-01-01' });

    fixture.componentInstance.submit();

    httpMock.expectNone('/api/v1/admin/backfill/reservations');
  });
});
