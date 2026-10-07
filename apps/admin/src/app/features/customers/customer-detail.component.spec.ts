import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '@rm/auth-web';
import { CustomerDetailComponent } from './customer-detail.component';
import { customerDetail, staffWith, testProviders } from './customers.spec-helpers';

function configure(permissions: string[], overrides: Record<string, unknown> = {}) {
  const setup = testProviders();
  TestBed.configureTestingModule({
    imports: [CustomerDetailComponent],
    providers: [...setup.providers, { provide: ActivatedRoute, useValue: { params: of({ customerId: 'cust-1' }) } }],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(permissions));
  const fixture = TestBed.createComponent(CustomerDetailComponent);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  httpMock.expectOne('/api/v1/admin/customers/cust-1').flush(customerDetail(overrides));
  fixture.detectChanges();
  return { fixture, httpMock };
}

describe('CustomerDetailComponent', () => {
  afterEach(() => localStorage.clear());

  it('shows only what the viewer may use', () => {
    const { fixture, httpMock } = configure(['customer.view']);

    httpMock.expectNone('/api/v1/admin/customers/cust-1/credit');
    httpMock.expectNone('/api/v1/public/trips');
    expect(fixture.nativeElement.querySelector('.customer-invite')).toBeNull();
    expect(fixture.nativeElement.querySelector('rm-customer-credit')).toBeNull();
    expect(fixture.nativeElement.querySelector('rm-counter-reservation')).toBeNull();
  });

  it('resends the invitation with customer.manage', () => {
    const { fixture, httpMock } = configure(['customer.view', 'customer.manage']);

    (fixture.nativeElement.querySelector('.customer-invite') as HTMLButtonElement).click();

    httpMock.expectOne('/api/v1/admin/customers/cust-1/invitation').flush(customerDetail());
  });

  it('offers no invitation to a customer who already has a password', () => {
    const { fixture } = configure(['customer.view', 'customer.manage'], { hasPassword: true, activatedAt: '2026-10-02T00:00:00.000Z' });

    expect(fixture.nativeElement.querySelector('.customer-invite')).toBeNull();
  });
});
