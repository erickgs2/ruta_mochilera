import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '@rm/auth-web';
import { CustomerListComponent, SEARCH_DEBOUNCE_MS } from './customer-list.component';
import { staffWith, testProviders } from './customers.spec-helpers';

function configure(permissions: string[]) {
  TestBed.configureTestingModule({ imports: [CustomerListComponent], providers: testProviders().providers });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(permissions));
  const fixture = TestBed.createComponent(CustomerListComponent);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController) };
}

const page = (items: unknown[] = [], total = items.length) => ({ items, total, page: 1, pageSize: 20 });
const customer = { id: 'c1', fullName: 'María Peña', email: 'maria@example.com', phone: '3521008079', origin: 'BRANCH', activatedAt: null, invitedAt: null, hasPassword: false, createdAt: '2026-10-01T00:00:00.000Z' };

describe('CustomerListComponent', () => {
  afterEach(() => localStorage.clear());

  it('waits for the typing to pause before searching, once', () => {
    jest.useFakeTimers();
    const { fixture, httpMock } = configure(['customer.view']);
    httpMock.expectOne((req) => req.url === '/api/v1/admin/customers' && !req.params.has('search')).flush(page());

    fixture.componentInstance.search.setValue('m');
    jest.advanceTimersByTime(100);
    fixture.componentInstance.search.setValue('mar');
    jest.advanceTimersByTime(100);
    fixture.componentInstance.search.setValue('maria');
    httpMock.expectNone((req) => req.params.has('search'));
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);

    const request = httpMock.expectOne((req) => req.url === '/api/v1/admin/customers');
    expect(request.request.params.get('search')).toBe('maria');
    expect(request.request.params.get('page')).toBe('1');
    request.flush(page([customer]));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('María Peña');
    jest.useRealTimers();
  });

  it('offers registration only with customer.manage', () => {
    const viewer = configure(['customer.view']);
    viewer.httpMock.expectOne('/api/v1/admin/customers?page=1&pageSize=20').flush(page());
    viewer.fixture.detectChanges();
    expect(viewer.fixture.nativeElement.querySelector('.customers-new')).toBeNull();
  });
});
