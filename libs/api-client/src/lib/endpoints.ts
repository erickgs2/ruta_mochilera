import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiClient } from './api-client';
import type { components, paths } from './schema';

/**
 * Extracts the `application/json` payload type out of a generated
 * request-body or response-content object (both share that shape in
 * `schema.d.ts`).
 */
type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** The JSON request body type for `paths[P][M]`. */
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody: infer R }
  ? Json<R>
  : never;

/** The 200 or 201 JSON response type for `paths[P][M]` -- every success status this API uses. */
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: { 200: infer R } }
  ? Json<R>
  : paths[P][M] extends { responses: { 201: infer R } }
    ? Json<R>
    : never;

/**
 * Auth: session issuance, rotation and revocation, plus the authenticated
 * caller's own profile (`/me`).
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly api = inject(ApiClient);

  /**
   * Always responds the same way whether or not `body.email` is already
   * registered -- see `registerCustomer`'s doc comment in `@rm/domain-identity`.
   * Responds with a `null` body on success; there is nothing to return.
   */
  register(body: Body<'/api/v1/auth/register', 'post'>): Observable<Ok<'/api/v1/auth/register', 'post'>> {
    return this.api.post('/api/v1/auth/register', body);
  }

  login(body: Body<'/api/v1/auth/login', 'post'>): Observable<Ok<'/api/v1/auth/login', 'post'>> {
    return this.api.post('/api/v1/auth/login', body);
  }

  /**
   * No argument and no request body: the refresh token travels only as the
   * httpOnly cookie `/auth/login` set, which `ApiClient`'s `withCredentials`
   * attaches automatically.
   */
  refresh(): Observable<Ok<'/api/v1/auth/refresh', 'post'>> {
    return this.api.post('/api/v1/auth/refresh', {});
  }

  /** Same cookie-only contract as `refresh()` -- see its doc comment. */
  logout(): Observable<void> {
    return this.api.post('/api/v1/auth/logout', {});
  }

  me(): Observable<Ok<'/api/v1/me', 'get'>> {
    return this.api.get('/api/v1/me');
  }
}

/** RBAC: the permission catalog and role CRUD. */
@Injectable({ providedIn: 'root' })
export class RbacApi {
  private readonly api = inject(ApiClient);

  listPermissions(): Observable<components['schemas']['Permission'][]> {
    return this.api.get('/api/v1/rbac/permissions');
  }

  listRoles(): Observable<Ok<'/api/v1/rbac/roles', 'get'>> {
    return this.api.get('/api/v1/rbac/roles');
  }

  createRole(body: Body<'/api/v1/rbac/roles', 'post'>): Observable<Ok<'/api/v1/rbac/roles', 'post'>> {
    return this.api.post('/api/v1/rbac/roles', body);
  }

  updateRole(
    roleId: string,
    body: Body<'/api/v1/rbac/roles/{roleId}', 'put'>
  ): Observable<Ok<'/api/v1/rbac/roles/{roleId}', 'put'>> {
    return this.api.put(`/api/v1/rbac/roles/${roleId}`, body);
  }

  /** 204 No Content on success -- there is no response body to type. */
  deleteRole(roleId: string): Observable<void> {
    return this.api.delete(`/api/v1/rbac/roles/${roleId}`);
  }
}

/** Staff (administrator) accounts. */
@Injectable({ providedIn: 'root' })
export class StaffApi {
  private readonly api = inject(ApiClient);

  list(search?: string): Observable<Ok<'/api/v1/staff', 'get'>> {
    return this.api.get('/api/v1/staff', { search });
  }

  create(body: Body<'/api/v1/staff', 'post'>): Observable<Ok<'/api/v1/staff', 'post'>> {
    return this.api.post('/api/v1/staff', body);
  }

  update(
    userId: string,
    body: Body<'/api/v1/staff/{userId}', 'put'>
  ): Observable<Ok<'/api/v1/staff/{userId}', 'put'>> {
    return this.api.put(`/api/v1/staff/${userId}`, body);
  }
}

/** Trips: catalog CRUD, status transitions and gallery images. */
@Injectable({ providedIn: 'root' })
export class TripsApi {
  private readonly api = inject(ApiClient);

  list(query: { status?: string; search?: string } = {}): Observable<Ok<'/api/v1/trips', 'get'>> {
    return this.api.get('/api/v1/trips', query);
  }

  get(tripId: string): Observable<Ok<'/api/v1/trips/{tripId}', 'get'>> {
    return this.api.get(`/api/v1/trips/${tripId}`);
  }

  create(body: Body<'/api/v1/trips', 'post'>): Observable<Ok<'/api/v1/trips', 'post'>> {
    return this.api.post('/api/v1/trips', body);
  }

  update(
    tripId: string,
    body: Body<'/api/v1/trips/{tripId}', 'put'>
  ): Observable<Ok<'/api/v1/trips/{tripId}', 'put'>> {
    return this.api.put(`/api/v1/trips/${tripId}`, body);
  }

  changeStatus(
    tripId: string,
    status: Body<'/api/v1/trips/{tripId}/status', 'put'>['status']
  ): Observable<Ok<'/api/v1/trips/{tripId}/status', 'put'>> {
    return this.api.put(`/api/v1/trips/${tripId}/status`, { status });
  }

  /**
   * Uploads a trip gallery image. Takes a `File` and builds the `multipart/
   * form-data` body itself -- the `file` field name matches what
   * `apps/api/.../trips/[tripId]/images/route.ts` reads off `formData()`, so
   * no caller has to know or repeat it.
   */
  uploadImage(tripId: string, file: File, altText?: string): Observable<Ok<'/api/v1/trips/{tripId}/images', 'post'>> {
    const form = new FormData();
    form.append('file', file);
    if (altText) form.append('altText', altText);
    return this.api.upload(`/api/v1/trips/${tripId}/images`, form);
  }

  deleteImage(
    tripId: string,
    imageId: string
  ): Observable<Ok<'/api/v1/trips/{tripId}/images/{imageId}', 'delete'>> {
    return this.api.delete(`/api/v1/trips/${tripId}/images/${imageId}`);
  }
}

/** Trip costing: budget line items and the pricing policy that derives the per-seat price from them. */
@Injectable({ providedIn: 'root' })
export class CostingApi {
  private readonly api = inject(ApiClient);

  get(tripId: string): Observable<Ok<'/api/v1/trips/{tripId}/costing', 'get'>> {
    return this.api.get(`/api/v1/trips/${tripId}/costing`);
  }

  addItem(
    tripId: string,
    body: Body<'/api/v1/trips/{tripId}/costing/items', 'post'>
  ): Observable<Ok<'/api/v1/trips/{tripId}/costing/items', 'post'>> {
    return this.api.post(`/api/v1/trips/${tripId}/costing/items`, body);
  }

  updateItem(
    tripId: string,
    itemId: string,
    body: Body<'/api/v1/trips/{tripId}/costing/items/{itemId}', 'put'>
  ): Observable<Ok<'/api/v1/trips/{tripId}/costing/items/{itemId}', 'put'>> {
    return this.api.put(`/api/v1/trips/${tripId}/costing/items/${itemId}`, body);
  }

  deleteItem(
    tripId: string,
    itemId: string
  ): Observable<Ok<'/api/v1/trips/{tripId}/costing/items/{itemId}', 'delete'>> {
    return this.api.delete(`/api/v1/trips/${tripId}/costing/items/${itemId}`);
  }

  setPricingPolicy(
    tripId: string,
    body: Body<'/api/v1/trips/{tripId}/costing', 'put'>
  ): Observable<Ok<'/api/v1/trips/{tripId}/costing', 'put'>> {
    return this.api.put(`/api/v1/trips/${tripId}/costing`, body);
  }
}
