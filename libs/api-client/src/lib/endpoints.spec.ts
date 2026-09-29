import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './api-client';
import { AuthApi, CostingApi, RbacApi, StaffApi, TripsApi } from './endpoints';

describe('endpoints', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_BASE_URL, useValue: 'https://api.test' }],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('AuthApi.me calls GET /api/v1/me', () => {
    TestBed.inject(AuthApi).me().subscribe();
    httpMock.expectOne('https://api.test/api/v1/me').flush({});
  });

  it('AuthApi.refresh posts the refresh token', () => {
    TestBed.inject(AuthApi).refresh('rtok').subscribe();
    const req = httpMock.expectOne('https://api.test/api/v1/auth/refresh');
    expect(req.request.body).toEqual({ refreshToken: 'rtok' });
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
