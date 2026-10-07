import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { CustomerFormComponent } from './customer-form.component';
import { customerDetail, staffWith, testProviders } from './customers.spec-helpers';

function configure() {
  const setup = testProviders();
  TestBed.configureTestingModule({
    imports: [CustomerFormComponent],
    providers: [...setup.providers, { provide: ActivatedRoute, useValue: {} }],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['customer.view', 'customer.manage']));
  const router = TestBed.inject(Router);
  const navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(CustomerFormComponent);
  fixture.detectChanges();
  fixture.componentInstance.form.setValue({
    fullName: 'María Peña',
    email: 'maria@example.com',
    phone: '352 100 80 79',
    birthDate: '1990-05-17',
    locale: 'es',
    sendInvitation: true,
  });
  return { fixture, httpMock: TestBed.inject(HttpTestingController), navigate, snackBarOpen: setup.snackBarOpen };
}

describe('CustomerFormComponent', () => {
  afterEach(() => localStorage.clear());

  it('registers with the invitation ticked by default and opens the new customer', () => {
    const { fixture, httpMock, navigate } = configure();

    fixture.componentInstance.submit();
    const request = httpMock.expectOne('/api/v1/admin/customers');
    expect(request.request.body).toMatchObject({ email: 'maria@example.com', sendInvitation: true });
    request.flush({ ...customerDetail(), invitationSent: true });

    expect(navigate).toHaveBeenCalledWith(['..', 'cust-1'], expect.anything());
  });

  it('opens the existing customer when the email is already registered', () => {
    const { fixture, httpMock, navigate, snackBarOpen } = configure();

    fixture.componentInstance.submit();
    httpMock
      .expectOne('/api/v1/admin/customers')
      .flush({ code: 'CUSTOMER_ALREADY_EXISTS', details: { customerId: 'existing-1' } }, { status: 409, statusText: 'Conflict' });

    expect(navigate).toHaveBeenCalledWith(['..', 'existing-1'], expect.anything());
    expect(snackBarOpen).toHaveBeenCalledWith('adminCustomers.form.alreadyExists', undefined, expect.anything());
  });

  it('does not send an incomplete form', () => {
    const { fixture, httpMock } = configure();
    fixture.componentInstance.form.controls.email.setValue('no-es-correo');

    fixture.componentInstance.submit();

    httpMock.expectNone('/api/v1/admin/customers');
  });
});
