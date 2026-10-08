import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { payment, reservation, type Payment, type ReservationDetail } from '../../testing/reservation-fixtures';
import { PaymentHistoryComponent } from './payment-history.component';

async function open(theReservation: ReservationDetail, payments: Payment[]) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'reservations/:id/payments', component: PaymentHistoryComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'payments.method.CARD',
      'payments.method.OXXO',
      'payments.status.PENDING',
      'payments.status.SUCCEEDED',
      'payments.history.empty',
      'errors.UNKNOWN',
    ])
  );
  TestBed.inject(LanguageService).use('es');
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/reservations/res-1/payments', PaymentHistoryComponent);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/reservations/res-1').flush(theReservation);
  http.expectOne('/api/v1/payments').flush(payments);
  harness.detectChanges();
  return { element: harness.routeNativeElement as HTMLElement, http, harness };
}

function rows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll('.payment-row'));
}

describe('PaymentHistoryComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it("lists this reservation's payments with method, date and amount, and none of another reservation's", async () => {
    const { element } = await open(reservation({ paidCents: 100_000, balanceCents: 400_000 }), [
      payment({ id: 'p-card', method: 'CARD', amountCents: 100_000, paidAt: '2026-10-01T15:00:00.000Z' }),
      payment({ id: 'p-other', reservationId: 'res-2', amountCents: 777_700 }),
    ]);

    expect(rows(element)).toHaveLength(1);
    const row = rows(element)[0];
    expect(row.textContent).toContain(shown('payments.method.CARD'));
    expect(row.textContent).toContain(formatMoney(100_000, 'es'));
    expect(row.querySelector('.payment-date')?.textContent).toContain('2026');
    expect(element.textContent).not.toContain(formatMoney(777_700, 'es'));
  });

  it("shows the remaining balance and the trip's payment deadline", async () => {
    const { element } = await open(
      reservation({ paidCents: 100_000, balanceCents: 400_000, paymentDeadline: '2028-02-01T00:00:00.000Z' }),
      [payment()]
    );

    expect(element.querySelector('.history-balance')?.textContent).toContain(formatMoney(400_000, 'es'));
    expect(element.querySelector('.history-deadline')?.textContent).toContain('2028');
  });

  it('marks a PENDING OXXO payment apart from a SUCCEEDED one and does not count it as paid', async () => {
    const { element } = await open(reservation({ paidCents: 100_000, balanceCents: 400_000 }), [
      payment({ id: 'p-oxxo', method: 'OXXO', status: 'PENDING', amountCents: 50_000, paidAt: null }),
      payment({ id: 'p-card', method: 'CARD', status: 'SUCCEEDED', amountCents: 100_000 }),
    ]);

    const [pending, succeeded] = rows(element);
    expect(pending.classList).toContain('payment-row--pending');
    expect(pending.textContent).toContain(shown('payments.status.PENDING'));
    expect(succeeded.classList).not.toContain('payment-row--pending');
    expect(succeeded.textContent).toContain(shown('payments.status.SUCCEEDED'));
    // Paid comes from the server's paidCents, which never includes a pending payment.
    expect(element.querySelector('.history-paid')?.textContent).toContain(formatMoney(100_000, 'es'));
    expect(element.querySelector('.history-paid')?.textContent).not.toContain(formatMoney(150_000, 'es'));
  });

  it('treats an abandoned PENDING card payment the same way: marked apart, not counted', async () => {
    const { element } = await open(reservation({ paidCents: 0, balanceCents: 500_000 }), [
      payment({ id: 'p-card-pending', method: 'CARD', status: 'PENDING', amountCents: 500_000, paidAt: null }),
    ]);

    expect(rows(element)[0].classList).toContain('payment-row--pending');
    expect(element.querySelector('.history-paid')?.textContent).toContain(formatMoney(0, 'es'));
  });

  it('shows the empty state when the reservation has no payments yet', async () => {
    const { element } = await open(reservation(), [payment({ reservationId: 'res-2' })]);

    expect(rows(element)).toHaveLength(0);
    expect(element.textContent).toContain(shown('payments.history.empty'));
  });

  it('lets the customer download the receipt of each confirmed payment (Phase 2B)', async () => {
    const createObjectURL = jest.fn().mockReturnValue('blob:receipt');
    Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL: jest.fn() });
    const { element, http } = await open(reservation(), [
      payment({ id: 'pay-1', status: 'SUCCEEDED', receiptNumber: 'RM-2026-000001' }),
      payment({ id: 'pay-2', status: 'PENDING', method: 'OXXO', paidAt: null, receiptNumber: null }),
    ]);

    const buttons = element.querySelectorAll('.payment-receipt');
    expect(buttons).toHaveLength(1);
    (buttons[0] as HTMLButtonElement).click();
    const request = http.expectOne('/api/v1/payments/pay-1/receipt');
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['%PDF-'], { type: 'application/pdf' }));
    expect(createObjectURL).toHaveBeenCalled();
  });
});

describe('PaymentHistoryComponent calendar days (America/Mexico_City)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the payment deadline as the stored day, not the day before', async () => {
    const { element } = await open(reservation({ paymentDeadline: '2028-02-01T00:00:00.000Z' }), [payment()]);

    const deadline = element.querySelector('.history-deadline')?.textContent;
    expect(deadline).toContain('1 feb 2028');
    expect(deadline).not.toContain('31 ene 2028');
  });
});
