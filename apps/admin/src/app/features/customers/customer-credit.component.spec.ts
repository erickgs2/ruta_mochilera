import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '@rm/auth-web';
import { CustomerCreditComponent } from './customer-credit.component';
import { staffWith, testProviders } from './customers.spec-helpers';

const CREDIT_URL = '/api/v1/admin/customers/cust-1/credit';
const credit = {
  balanceCents: 150_000,
  entries: [{ id: 'e1', amountCents: 150_000, kind: 'CANCELLATION', reservationId: 'r1', paymentId: null, reason: null, createdAt: '2026-10-01T10:00:00.000Z' }],
};

function configure(permissions: string[], dialogResult = true) {
  const setup = testProviders(dialogResult);
  TestBed.configureTestingModule({ imports: [CustomerCreditComponent], providers: setup.providers });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(permissions));
  const fixture = TestBed.createComponent(CustomerCreditComponent);
  fixture.componentRef.setInput('customerId', 'cust-1');
  fixture.componentRef.setInput('customerName', 'María Peña');
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  httpMock.expectOne(CREDIT_URL).flush(credit);
  fixture.detectChanges();
  return { fixture, httpMock, dialogOpen: setup.dialogOpen };
}

describe('CustomerCreditComponent', () => {
  afterEach(() => localStorage.clear());

  it('shows the balance and every movement', () => {
    const { fixture } = configure(['payment.view']);

    expect(fixture.nativeElement.querySelector('.credit-balance').textContent).toContain('1,500.00');
    expect(fixture.nativeElement.querySelectorAll('.credit-table tr.mat-mdc-row')).toHaveLength(1);
  });

  it('hides refund and adjustment without payment.credit.apply', () => {
    const { fixture } = configure(['payment.view']);

    expect(fixture.nativeElement.querySelector('.credit-refund')).toBeNull();
    expect(fixture.nativeElement.querySelector('.credit-adjust')).toBeNull();
  });

  it('records a refund only with a reason and after confirming', () => {
    const { fixture, httpMock, dialogOpen } = configure(['payment.view', 'payment.credit.apply']);
    const component = fixture.componentInstance;

    component.open('refund');
    component.form.controls.amountCents.setValue(50_000);
    component.submit();
    expect(dialogOpen).not.toHaveBeenCalled();

    component.form.controls.reason.setValue('Devuelto en efectivo');
    component.submit();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    const request = httpMock.expectOne(`${CREDIT_URL}/refund`);
    expect(request.request.body).toEqual({ amountCents: 50_000, reason: 'Devuelto en efectivo' });
    request.flush({});
    httpMock.expectOne(CREDIT_URL).flush(credit);
  });

  it('sends a decrease as a negative adjustment', () => {
    const { fixture, httpMock } = configure(['payment.view', 'payment.credit.apply']);
    const component = fixture.componentInstance;

    component.open('adjust');
    component.form.setValue({ amountCents: 20_000, direction: 'decrease', reason: 'Corrección' });
    component.submit();

    expect(httpMock.expectOne(`${CREDIT_URL}/adjust`).request.body).toEqual({ amountCents: -20_000, reason: 'Corrección' });
  });

  it('does nothing when the confirmation is dismissed', () => {
    const { fixture, httpMock } = configure(['payment.view', 'payment.credit.apply'], false);
    const component = fixture.componentInstance;

    component.open('adjust');
    component.form.setValue({ amountCents: 20_000, direction: 'increase', reason: 'Cortesía' });
    component.submit();

    httpMock.expectNone(`${CREDIT_URL}/adjust`);
  });
});
