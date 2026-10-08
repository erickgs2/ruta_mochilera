import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { ReservationDetailComponent } from './reservation-detail.component';

const URL = '/api/v1/admin/reservations/res-1';

// jsdom has no object URLs; the receipt download needs one.
const URL_CREATE = jest.fn();
Object.assign(globalThis.URL, { createObjectURL: URL_CREATE, revokeObjectURL: jest.fn() });

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    code: 'RM-AAAA-BBBB',
    tripId: 'trip-1',
    customerId: 'cust-1',
    status: 'ACTIVE',
    holdExpiresAt: null,
    totalPriceCents: 500_000,
    minimumDepositCents: 100_000,
    paidCents: 150_000,
    balanceCents: 350_000,
    paymentDeadline: '2027-11-01T00:00:00.000Z',
    cancellationRequestedAt: '2027-01-02T10:00:00.000Z',
    createdAt: '2027-01-01T10:00:00.000Z',
    tripName: 'Oaxaca Mágica',
    tripDepartureDate: '2027-12-01T00:00:00.000Z',
    customerName: 'Ana Pérez',
    customerEmail: 'ana@example.com',
    customerPhone: '5512345678',
    cancellationReason: 'Me enfermé',
    cancellationPending: true,
    cancelledAt: null,
    cancelledByName: null,
    cancellationDeclinedAt: null,
    cancellationDeclinedByName: null,
    cancellationDeclineReason: null,
    ...overrides,
  };
}

const payments = [
  {
    id: 'pay-1',
    reservationId: 'res-1',
    amountCents: 150_000,
    method: 'CARD',
    status: 'SUCCEEDED',
    provider: 'STRIPE',
    paidAt: '2027-01-01T11:00:00.000Z',
    recordedAt: '2027-01-01T11:00:00.000Z',
    providerVoucherUrl: null,
    voucherExpiresAt: null,
    receiptNumber: null,
  },
];

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

function configure(permissions: string[], dialogResult = true) {
  const dialogOpen = jest.fn().mockReturnValue({ afterClosed: () => of(dialogResult) });
  const snackBarOpen = jest.fn();
  TestBed.configureTestingModule({
    imports: [ReservationDetailComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: ActivatedRoute, useValue: { params: of({ reservationId: 'res-1' }) } },
      { provide: MatDialog, useValue: { open: dialogOpen } },
      { provide: MatSnackBar, useValue: { open: snackBarOpen } },
    ],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', userWith(permissions));
  const fixture = TestBed.createComponent(ReservationDetailComponent);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController), dialogOpen, snackBarOpen };
}

describe('ReservationDetailComponent', () => {
  afterEach(() => localStorage.clear());

  it("shows the customer's request and its reason, highlighted while it is pending", () => {
    const { fixture, httpMock } = configure(['reservation.view']);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();

    const request = fixture.nativeElement.querySelector('.reservation-request') as HTMLElement;
    expect(request.classList.contains('reservation-request-pending')).toBe(true);
    expect(request.textContent).toContain('Me enfermé');
  });

  it('loads the payment history only for someone holding payment.view', () => {
    const { fixture, httpMock } = configure(['reservation.view', 'payment.view']);
    httpMock.expectOne(URL).flush(detail());
    httpMock.expectOne(`${URL}/payments`).flush(payments);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.reservation-payments-table tr.mat-mdc-row')).toHaveLength(1);
  });

  it('never asks for the payment history without payment.view', () => {
    const { fixture, httpMock } = configure(['reservation.view']);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();

    httpMock.expectNone(`${URL}/payments`);
    expect(fixture.nativeElement.querySelector('.reservation-payments')).toBeNull();
  });

  it('hides the cancel action without reservation.cancel', () => {
    const { fixture, httpMock } = configure(['reservation.view']);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reservation-cancel')).toBeNull();
  });

  it.each(['CANCELLED', 'EXPIRED'])('hides the cancel action on a %s reservation, even with the permission', (status) => {
    const { fixture, httpMock } = configure(['reservation.view', 'reservation.cancel']);
    httpMock.expectOne(URL).flush(detail({ status, cancellationPending: false }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reservation-cancel')).toBeNull();
  });

  it('keeps the button disabled until a reason is written', () => {
    const { fixture, httpMock } = configure(['reservation.view', 'reservation.cancel']);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.reservation-cancel-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fixture.componentInstance.reason.setValue('   ');
    fixture.detectChanges();
    expect(button.disabled).toBe(true);

    fixture.componentInstance.reason.setValue('Viaje reprogramado');
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
  });

  it('confirms what is released and what is kept, then cancels with the reason', () => {
    const { fixture, httpMock, dialogOpen, snackBarOpen } = configure(['reservation.view', 'reservation.cancel']);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();
    fixture.componentInstance.reason.setValue('  Viaje reprogramado ');

    fixture.componentInstance.cancel();

    const data = dialogOpen.mock.calls[0][1].data;
    expect(data.title).toBe('adminReservations.cancelTitle');
    expect(data.message).toBe('adminReservations.cancelMessage');
    const request = httpMock.expectOne(`${URL}/cancel`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'Viaje reprogramado' });
    request.flush(detail({ status: 'CANCELLED', cancellationPending: false, cancelledAt: '2027-01-03T00:00:00.000Z', cancelledByName: 'Ana' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.reservation()?.status).toBe('CANCELLED');
    expect(fixture.nativeElement.querySelector('.reservation-cancel')).toBeNull();
    expect(snackBarOpen).toHaveBeenCalled();
  });

  it('sends nothing when the confirmation is dismissed', () => {
    const { fixture, httpMock } = configure(['reservation.view', 'reservation.cancel'], false);
    httpMock.expectOne(URL).flush(detail());
    fixture.detectChanges();
    fixture.componentInstance.reason.setValue('Viaje reprogramado');

    fixture.componentInstance.cancel();

    httpMock.expectNone(`${URL}/cancel`);
  });

  it('reports the API error and reloads the reservation as it now is', () => {
    const { fixture, httpMock, snackBarOpen } = configure(['reservation.view', 'reservation.cancel']);
    httpMock.expectOne(URL).flush(detail({ status: 'HELD' }));
    fixture.detectChanges();
    fixture.componentInstance.reason.setValue('Viaje reprogramado');

    fixture.componentInstance.cancel();
    httpMock
      .expectOne(`${URL}/cancel`)
      .flush({ code: 'INVALID_STATUS_TRANSITION' }, { status: 409, statusText: 'Conflict' });

    expect(snackBarOpen).toHaveBeenCalled();
    httpMock.expectOne(URL).flush(detail({ status: 'EXPIRED', cancellationPending: false }));
    fixture.detectChanges();
    expect(fixture.componentInstance.reservation()?.status).toBe('EXPIRED');
  });

  it('shows the error code when the reservation cannot be loaded', () => {
    const { fixture, httpMock } = configure(['reservation.view']);
    httpMock.expectOne(URL).flush({ code: 'NOT_FOUND' }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reservation-error')).not.toBeNull();
  });

  describe('declining the request', () => {
    it('is offered on a pending request to someone holding reservation.cancel, and sends the reason', () => {
      const { fixture, httpMock, dialogOpen } = configure(['reservation.view', 'reservation.cancel']);
      httpMock.expectOne(URL).flush(detail());
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector('.reservation-decline-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);

      fixture.componentInstance.declineReason.setValue(' El anticipo no es reembolsable ');
      fixture.detectChanges();
      expect(button.disabled).toBe(false);
      fixture.componentInstance.decline();

      expect(dialogOpen.mock.calls[0][1].data.title).toBe('adminReservations.declineTitle');
      const request = httpMock.expectOne(`${URL}/decline-cancellation`);
      expect(request.request.body).toEqual({ reason: 'El anticipo no es reembolsable' });
      request.flush(
        detail({
          cancellationPending: false,
          cancellationDeclinedAt: '2027-01-03T00:00:00.000Z',
          cancellationDeclinedByName: 'Ana',
          cancellationDeclineReason: 'El anticipo no es reembolsable',
        })
      );
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.reservation-decline')).toBeNull();
      expect(fixture.nativeElement.querySelector('.reservation-declined')?.textContent).toContain(
        'El anticipo no es reembolsable'
      );
      // Declining is not cancelling: the reservation can still be cancelled.
      expect(fixture.nativeElement.querySelector('.reservation-cancel')).not.toBeNull();
    });

    it('is not offered without reservation.cancel', () => {
      const { fixture, httpMock } = configure(['reservation.view']);
      httpMock.expectOne(URL).flush(detail());
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.reservation-decline')).toBeNull();
    });

    it('is not offered once the request is no longer pending', () => {
      const { fixture, httpMock } = configure(['reservation.view', 'reservation.cancel']);
      httpMock
        .expectOne(URL)
        .flush(detail({ cancellationPending: false, cancellationDeclinedAt: '2027-01-03T00:00:00.000Z' }));
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.reservation-decline')).toBeNull();
    });

    it('sends nothing when the confirmation is dismissed', () => {
      const { fixture, httpMock } = configure(['reservation.view', 'reservation.cancel'], false);
      httpMock.expectOne(URL).flush(detail());
      fixture.detectChanges();
      fixture.componentInstance.declineReason.setValue('No');

      fixture.componentInstance.decline();

      httpMock.expectNone(`${URL}/decline-cancellation`);
    });
  });

  describe('counter actions (Phase 2B)', () => {
    const receiptPayment = { ...payments[0], method: 'CASH', receiptNumber: 'RM-2027-000001' };

    it('hides cash, credit and receipts without their permissions', () => {
      const { fixture, httpMock } = configure(['reservation.view']);
      httpMock.expectOne(URL).flush(detail());
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.reservation-cash')).toBeNull();
      expect(fixture.nativeElement.querySelector('.reservation-credit')).toBeNull();
      httpMock.expectNone('/api/v1/admin/customers/cust-1/credit');
    });

    it('takes cash up to the balance, after confirming', () => {
      const { fixture, httpMock, dialogOpen } = configure(['reservation.view', 'payment.register']);
      httpMock.expectOne(URL).flush(detail());
      fixture.detectChanges();
      const component = fixture.componentInstance;

      component.cashAmount.setValue(350_001);
      component.registerCash();
      expect(dialogOpen).not.toHaveBeenCalled();
      httpMock.expectNone(`${URL}/payments`);

      component.cashAmount.setValue(100_000);
      component.registerCash();
      const request = httpMock.expectOne((req) => req.method === 'POST' && req.url === `${URL}/payments`);
      expect(request.request.body).toEqual({ amountCents: 100_000 });
      request.flush(receiptPayment);
      httpMock.expectOne(URL).flush(detail({ paidCents: 250_000, balanceCents: 250_000 }));
    });

    it('applies credit no larger than what the customer has', () => {
      const { fixture, httpMock } = configure(['reservation.view', 'payment.view', 'payment.credit.apply']);
      httpMock.expectOne(URL).flush(detail());
      httpMock.expectOne(`${URL}/payments`).flush(payments);
      httpMock.expectOne('/api/v1/admin/customers/cust-1/credit').flush({ balanceCents: 50_000, entries: [] });
      fixture.detectChanges();
      const component = fixture.componentInstance;

      component.creditAmount.setValue(60_000);
      component.applyCredit();
      httpMock.expectNone(`${URL}/apply-credit`);

      component.creditAmount.setValue(50_000);
      component.applyCredit();
      expect(httpMock.expectOne(`${URL}/apply-credit`).request.body).toEqual({ amountCents: 50_000 });
    });

    it('repeats the payment status inside the method cell for narrow screens', () => {
      const { fixture, httpMock } = configure(['reservation.view', 'payment.view']);
      httpMock.expectOne(URL).flush(detail());
      httpMock.expectOne(`${URL}/payments`).flush([receiptPayment]);
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('.reservation-payments-table tr.mat-mdc-row') as HTMLElement;
      const inline = row.querySelector('.mat-column-method .reservation-payment-status-inline');
      expect(inline?.textContent).toContain(`payments.status.${receiptPayment.status}`);
      expect(row.querySelector('.reservation-receipt-actions .reservation-receipt-download')).not.toBeNull();
    });

    it('downloads and resends a receipt from the payment history', () => {
      const { fixture, httpMock } = configure(['reservation.view', 'payment.view']);
      httpMock.expectOne(URL).flush(detail());
      httpMock.expectOne(`${URL}/payments`).flush([receiptPayment]);
      fixture.detectChanges();
      URL_CREATE.mockReturnValue('blob:receipt');

      (fixture.nativeElement.querySelector('.reservation-receipt-download') as HTMLButtonElement).click();
      const download = httpMock.expectOne('/api/v1/admin/payments/pay-1/receipt');
      expect(download.request.responseType).toBe('blob');
      download.flush(new Blob(['%PDF-'], { type: 'application/pdf' }));
      expect(URL_CREATE).toHaveBeenCalled();

      (fixture.nativeElement.querySelector('.reservation-receipt-resend') as HTMLButtonElement).click();
      httpMock.expectOne('/api/v1/admin/payments/pay-1/receipt/resend').flush(null);
    });
  });
});


describe('ReservationDetailComponent calendar days (America/Mexico_City)', () => {
  afterEach(() => localStorage.clear());

  it('shows the trip departure and the payment deadline as the stored days, not the day before', () => {
    localStorage.setItem('rm.locale', 'es');
    const { fixture, httpMock } = configure(['reservation.view']);
    httpMock
      .expectOne(URL)
      .flush(detail({ tripDepartureDate: '2027-12-01T00:00:00.000Z', paymentDeadline: '2027-11-01T00:00:00.000Z' }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1 dic 2027');
    expect(text).toContain('1 nov 2027');
    expect(text).not.toContain('30 nov 2027');
    expect(text).not.toContain('31 oct 2027');
  });
});
