import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './api-client';
import { AuthApi, CostingApi, PublicCatalogueApi, RbacApi, StaffApi, TripsApi } from './endpoints';

describe('endpoints', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_BASE_URL, useValue: 'https://api.test' }],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('AuthApi.register posts the registration payload as JSON', () => {
    const body = {
      email: 'new.customer@example.com',
      password: 'a-long-enough-password',
      fullName: 'Ana Customer',
      phone: '+52 55 1234 5678',
      birthDate: '1990-01-01',
      acceptTerms: true as const,
    };
    TestBed.inject(AuthApi).register(body).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/register');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(body);
    req.flush(null);
  });

  it('AuthApi.verifyEmail posts the email and the six-digit code', () => {
    TestBed.inject(AuthApi).verifyEmail({ email: 'ana@example.com', code: '123456' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/verify-email');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'ana@example.com', code: '123456' });
    req.flush(null);
  });

  it('AuthApi.resendCode posts the email to resend-code', () => {
    TestBed.inject(AuthApi).resendCode({ email: 'ana@example.com' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/resend-code');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'ana@example.com' });
    req.flush(null);
  });

  it('AuthApi.forgotPassword posts the email to forgot-password', () => {
    TestBed.inject(AuthApi).forgotPassword({ email: 'ana@example.com' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/forgot-password');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'ana@example.com' });
    req.flush(null);
  });

  it('AuthApi.resetPassword posts the token and the new password', () => {
    TestBed.inject(AuthApi).resetPassword({ token: 'tok', newPassword: 'a-long-enough-password' }).subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/reset-password');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok', newPassword: 'a-long-enough-password' });
    req.flush(null);
  });

  it('PublicCatalogueApi.list calls GET /api/v1/public/trips', () => {
    TestBed.inject(PublicCatalogueApi).list().subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/public/trips');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('PublicCatalogueApi.get calls GET /api/v1/public/trips/{slug}, URL-encoding the slug', () => {
    TestBed.inject(PublicCatalogueApi).get('oaxaca mágica').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/public/trips/oaxaca%20m%C3%A1gica');
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('AuthApi.me calls GET /api/v1/me', () => {
    TestBed.inject(AuthApi).me().subscribe();
    httpMock.expectOne('https://api.test/api/v1/me').flush({});
  });

  it('AuthApi.refresh posts with no body -- the refresh token travels as a cookie, not JSON', () => {
    TestBed.inject(AuthApi).refresh().subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/refresh');
    expect(req.request.body).toEqual({});
    req.flush({});
  });

  it('RbacApi.deleteRole issues a DELETE', () => {
    TestBed.inject(RbacApi).deleteRole('r1').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/rbac/roles/r1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('StaffApi.list forwards the search query param', () => {
    TestBed.inject(StaffApi).list('ana').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/staff?search=ana');
    req.flush([]);
  });

  it('TripsApi.uploadImage builds multipart FormData with the "file" field', () => {
    const file = new File(['bytes'], 'cover.jpg', { type: 'image/jpeg' });
    TestBed.inject(TripsApi).uploadImage('trip1', file, 'Cover').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips/trip1/images');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as FormData;
    expect(body.get('file')).toBe(file);
    expect(body.get('altText')).toBe('Cover');
    req.flush({});
  });

  it('TripsApi.changeStatus puts the new status', () => {
    TestBed.inject(TripsApi).changeStatus('trip1', 'PUBLISHED').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips/trip1/status');
    expect(req.request.body).toEqual({ status: 'PUBLISHED' });
    req.flush({});
  });

  it('CostingApi.addItem posts to the items collection', () => {
    TestBed.inject(CostingApi)
      .addItem('trip1', { concept: 'Bus', quantity: 1, unitAmountCents: 1000 })
      .subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/trips/trip1/costing/items');
    expect(req.request.method).toBe('POST');
    req.flush({});
  });
});
