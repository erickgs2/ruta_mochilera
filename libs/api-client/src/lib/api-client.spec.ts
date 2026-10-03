import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL, ApiClient } from './api-client';

describe('ApiClient', () => {
  let client: ApiClient;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_BASE_URL, useValue: 'https://api.test' }],
    });
    client = TestBed.inject(ApiClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('prefixes GET requests with the injected base URL', () => {
    client.get('/api/v1/trips').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('sends every request with credentials, so the browser attaches the refresh-token cookie where it applies', () => {
    // The refresh token now lives only in an httpOnly cookie (see
    // apps/api/src/lib/http/refresh-cookie.ts); without withCredentials the
    // browser never attaches it, even same-origin.
    client.get('/api/v1/trips').subscribe();
    expect(httpMock.expectOne('https://api.test/api/v1/trips').request.withCredentials).toBe(true);

    client.post('/api/v1/auth/login', {}).subscribe();
    expect(httpMock.expectOne('https://api.test/api/v1/auth/login').request.withCredentials).toBe(true);

    client.put('/api/v1/trips/t1', {}).subscribe();
    expect(httpMock.expectOne('https://api.test/api/v1/trips/t1').request.withCredentials).toBe(true);

    client.delete('/api/v1/rbac/roles/r1').subscribe();
    expect(httpMock.expectOne('https://api.test/api/v1/rbac/roles/r1').request.withCredentials).toBe(true);

    const form = new FormData();
    client.upload('/api/v1/trips/t1/images', form).subscribe();
    expect(httpMock.expectOne('https://api.test/api/v1/trips/t1/images').request.withCredentials).toBe(true);

    httpMock.match(() => true).forEach((req) => req.flush({}));
  });

  it('omits undefined and empty-string query parameters', () => {
    client.get('/api/v1/staff', { search: undefined, status: '' }).subscribe();
    const req = httpMock.expectOne((r) => r.url === 'https://api.test/api/v1/staff');
    expect(req.request.params.keys()).toEqual([]);
    req.flush([]);
  });

  it('includes a defined query parameter', () => {
    client.get('/api/v1/staff', { search: 'ana' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/staff?search=ana');
    expect(req.request.params.get('search')).toBe('ana');
    req.flush([]);
  });

  it('sends a JSON body on POST', () => {
    client.post('/api/v1/auth/login', { email: 'a@b.com', password: 'x' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/login');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'a@b.com', password: 'x' });
    req.flush({});
  });

  it('sends a JSON body on PUT', () => {
    client.put('/api/v1/trips/t1', { totalCapacity: 10 }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips/t1');
    expect(req.request.method).toBe('PUT');
    req.flush({});
  });

  it('issues a DELETE with no body', () => {
    client.delete('/api/v1/rbac/roles/r1').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/rbac/roles/r1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('uploads a FormData body as a POST', () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'a.png'));
    client.upload('/api/v1/trips/t1/images', form).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips/t1/images');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBe(form);
    req.flush({});
  });
});
