import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { staffWith, testProviders } from '../customers/customers.spec-helpers';
import { ImportsListComponent } from './imports-list.component';

Object.assign(globalThis.URL, { createObjectURL: jest.fn().mockReturnValue('blob:x'), revokeObjectURL: jest.fn() });

function configure() {
  const setup = testProviders();
  TestBed.configureTestingModule({ imports: [ImportsListComponent], providers: setup.providers });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['import.manage']));
  const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ImportsListComponent);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  httpMock.expectOne('/api/v1/admin/imports').flush([]);
  fixture.detectChanges();
  return { fixture, httpMock, navigate, snackBarOpen: setup.snackBarOpen };
}

describe('ImportsListComponent', () => {
  afterEach(() => localStorage.clear());

  it('downloads both templates', () => {
    const { fixture, httpMock } = configure();

    (fixture.nativeElement.querySelector('.imports-template-customers') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('.imports-template-payments') as HTMLButtonElement).click();

    httpMock.expectOne('/api/v1/admin/imports/templates/customers').flush(new Blob(['a']));
    httpMock.expectOne('/api/v1/admin/imports/templates/payments').flush(new Blob(['b']));
  });

  it('uploads the file text for validation, emails off by default, and opens the preview', async () => {
    const { fixture, httpMock, navigate } = configure();
    const file = new File(['full_name,email\n'], 'clientes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('full_name,email\n') });
    fixture.componentInstance.file.set(file);

    await fixture.componentInstance.upload();
    const request = httpMock.expectOne((req) => req.method === 'POST' && req.url === '/api/v1/admin/imports');
    expect(request.request.body).toEqual({ type: 'CUSTOMERS', fileName: 'clientes.csv', content: 'full_name,email\n', sendEmails: false });
    request.flush({ id: 'batch-1' });

    expect(navigate).toHaveBeenCalledWith(['/imports', 'batch-1']);
  });

  it('refuses a file over 5 MB before uploading it', async () => {
    const { fixture, httpMock, snackBarOpen } = configure();
    const file = new File(['x'], 'big.csv');
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    fixture.componentInstance.file.set(file);

    await fixture.componentInstance.upload();

    httpMock.expectNone((req) => req.method === 'POST');
    expect(snackBarOpen).toHaveBeenCalled();
  });
});
