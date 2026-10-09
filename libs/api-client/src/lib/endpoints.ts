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

/** The 200, 201 or 202 JSON response type for `paths[P][M]` -- every success status this API uses. */
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: { 200: infer R } }
  ? Json<R>
  : paths[P][M] extends { responses: { 201: infer R } }
    ? Json<R>
    : paths[P][M] extends { responses: { 202: infer R } }
      ? Json<R> extends never
        ? unknown
        : Json<R>
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

  /** Same `null`-body contract as `register()`. Fails with `OTP_INVALID`, `OTP_EXPIRED` or `OTP_MAX_ATTEMPTS`. */
  verifyEmail(body: Body<'/api/v1/auth/verify-email', 'post'>): Observable<Ok<'/api/v1/auth/verify-email', 'post'>> {
    return this.api.post('/api/v1/auth/verify-email', body);
  }

  /**
   * Answers the same way whether or not `body.email` has an account or is
   * already verified. Fails with `OTP_RESEND_TOO_SOON` inside the cooldown.
   */
  resendCode(body: Body<'/api/v1/auth/resend-code', 'post'>): Observable<Ok<'/api/v1/auth/resend-code', 'post'>> {
    return this.api.post('/api/v1/auth/resend-code', body);
  }

  /** Answers the same way whether or not `body.email` has an account -- see `requestPasswordReset`. */
  forgotPassword(
    body: Body<'/api/v1/auth/forgot-password', 'post'>
  ): Observable<Ok<'/api/v1/auth/forgot-password', 'post'>> {
    return this.api.post('/api/v1/auth/forgot-password', body);
  }

  /**
   * Fails with `TOKEN_INVALID` (401) for an unknown, expired or already-used
   * token. On success the server revokes every live session of the account.
   */
  resetPassword(
    body: Body<'/api/v1/auth/reset-password', 'post'>
  ): Observable<Ok<'/api/v1/auth/reset-password', 'post'>> {
    return this.api.post('/api/v1/auth/reset-password', body);
  }

  /**
   * A counter customer activates their account from the invitation link
   * (Phase 2B). Fails with `TOKEN_INVALID` for an unknown, used or expired link.
   */
  acceptInvitation(
    body: Body<'/api/v1/auth/invitation/accept', 'post'>
  ): Observable<Ok<'/api/v1/auth/invitation/accept', 'post'>> {
    return this.api.post('/api/v1/auth/invitation/accept', body);
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

/**
 * The public trip catalogue: no authentication, PUBLISHED trips only, and
 * none of the internal fields (budget, margin, pre-sold seats) `TripsApi`
 * exposes to staff.
 */
@Injectable({ providedIn: 'root' })
export class PublicCatalogueApi {
  private readonly api = inject(ApiClient);

  list(): Observable<Ok<'/api/v1/public/trips', 'get'>> {
    return this.api.get('/api/v1/public/trips');
  }

  /** Answers 404 `NOT_FOUND` both for an unknown slug and for a trip that is not PUBLISHED. */
  get(slug: string): Observable<Ok<'/api/v1/public/trips/{slug}', 'get'>> {
    return this.api.get(`/api/v1/public/trips/${encodeURIComponent(slug)}`);
  }
}

/**
 * The authenticated customer's own reservations and the payment flow that
 * starts from one. Ownership is checked by the API on every call.
 */
@Injectable({ providedIn: 'root' })
export class ReservationsApi {
  private readonly api = inject(ApiClient);

  /** The customer's own reservations, newest first, cancelled and expired ones included. */
  list(): Observable<Ok<'/api/v1/reservations', 'get'>> {
    return this.api.get('/api/v1/reservations');
  }

  /** Creates a `HELD` reservation (the hold). The answer carries total, minimum deposit and `suggestedMonthlyCents`. */
  create(tripId: string): Observable<Ok<'/api/v1/reservations', 'post'>> {
    return this.api.post('/api/v1/reservations', { tripId });
  }

  get(reservationId: string): Observable<Ok<'/api/v1/reservations/{reservationId}', 'get'>> {
    return this.api.get(`/api/v1/reservations/${reservationId}`);
  }

  /**
   * Asks staff to cancel (Phase 2B wires the button). Never changes the
   * status by itself; asking again after a decline opens a new request.
   */
  requestCancellation(
    reservationId: string,
    reason?: string
  ): Observable<Ok<'/api/v1/reservations/{reservationId}/cancellation-requests', 'post'>> {
    return this.api.post(`/api/v1/reservations/${reservationId}/cancellation-requests`, reason ? { reason } : {});
  }

  /**
   * The body is an intent and a method. `FULL` and `DEPOSIT` carry no number
   * of cents: the API decides the amount from the reservation's own balance.
   * Only `AMOUNT` carries `amountCents` (a free-amount instalment), which the
   * API validates against the balance and the minimums. Either way it echoes
   * the amount it will charge back as `amountCents`.
   */
  createPaymentIntent(
    reservationId: string,
    body: Body<'/api/v1/reservations/{reservationId}/payment-intents', 'post'>
  ): Observable<Ok<'/api/v1/reservations/{reservationId}/payment-intents', 'post'>> {
    return this.api.post(`/api/v1/reservations/${reservationId}/payment-intents`, body);
  }
}

/**
 * The authenticated customer's own profile. No id anywhere: the API always
 * acts on the caller. The email is read-only -- `update` cannot carry it.
 */
@Injectable({ providedIn: 'root' })
export class ProfileApi {
  private readonly api = inject(ApiClient);

  get(): Observable<Ok<'/api/v1/me/profile', 'get'>> {
    return this.api.get('/api/v1/me/profile');
  }

  update(body: Body<'/api/v1/me/profile', 'patch'>): Observable<Ok<'/api/v1/me/profile', 'patch'>> {
    return this.api.patch('/api/v1/me/profile', body);
  }

  /** The `file` field name matches what `me/profile/photo/route.ts` reads. */
  uploadPhoto(file: File): Observable<Ok<'/api/v1/me/profile/photo', 'post'>> {
    const form = new FormData();
    form.append('file', file);
    return this.api.upload('/api/v1/me/profile/photo', form);
  }
}

/** The authenticated customer's own payments, across all their reservations, newest first. */
@Injectable({ providedIn: 'root' })
export class PaymentsApi {
  private readonly api = inject(ApiClient);

  list(): Observable<Ok<'/api/v1/payments', 'get'>> {
    return this.api.get('/api/v1/payments');
  }

  /** The PDF receipt of one of the caller's own SUCCEEDED payments (Phase 2B). */
  receipt(paymentId: string): Observable<Blob> {
    return this.api.getBlob(`/api/v1/payments/${paymentId}/receipt`);
  }

  /** The caller's own credit balance and movements, read-only (Phase 2B). */
  credit(): Observable<Ok<'/api/v1/me/credit', 'get'>> {
    return this.api.get('/api/v1/me/credit');
  }
}

/** The authenticated customer's own in-app inbox. */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiClient);

  /** Newest first; pass the previous page's `nextCursor` to continue. */
  list(cursor?: string): Observable<Ok<'/api/v1/notifications', 'get'>> {
    return this.api.get('/api/v1/notifications', { cursor });
  }

  markRead(deliveryId: string): Observable<Ok<'/api/v1/notifications/{deliveryId}/read', 'post'>> {
    return this.api.post(`/api/v1/notifications/${deliveryId}/read`, {});
  }

  /** Marks every unread item of the caller's own inbox as read. */
  markAllRead(): Observable<Ok<'/api/v1/notifications/read-all', 'post'>> {
    return this.api.post('/api/v1/notifications/read-all', {});
  }
}

/** The query `AdminReservationsApi.list` accepts: the generated query type of `GET /api/v1/admin/reservations`. */
type AdminReservationsQuery = NonNullable<paths['/api/v1/admin/reservations']['get']['parameters']['query']>;

/**
 * The panel's view of every customer's reservations (Task 19). Each call is
 * gated by the API on its own permission -- `reservation.view` to read,
 * `payment.view` for the payment history, `reservation.cancel` to cancel --
 * whatever the screen chooses to show.
 */
@Injectable({ providedIn: 'root' })
export class AdminReservationsApi {
  private readonly api = inject(ApiClient);

  /** Unresolved cancellation requests first, oldest request first; the rest newest first. */
  list(query: AdminReservationsQuery = {}): Observable<Ok<'/api/v1/admin/reservations', 'get'>> {
    return this.api.get('/api/v1/admin/reservations', query);
  }

  get(reservationId: string): Observable<Ok<'/api/v1/admin/reservations/{reservationId}', 'get'>> {
    return this.api.get(`/api/v1/admin/reservations/${reservationId}`);
  }

  payments(reservationId: string): Observable<Ok<'/api/v1/admin/reservations/{reservationId}/payments', 'get'>> {
    return this.api.get(`/api/v1/admin/reservations/${reservationId}/payments`);
  }

  /** Idempotent on the API side: cancelling twice answers the already-cancelled reservation. */
  cancel(
    reservationId: string,
    reason: string
  ): Observable<Ok<'/api/v1/admin/reservations/{reservationId}/cancel', 'post'>> {
    return this.api.post(`/api/v1/admin/reservations/${reservationId}/cancel`, { reason });
  }

  /** Closes the customer's pending request without cancelling; the customer is told why and may ask again. */
  declineCancellation(
    reservationId: string,
    reason: string
  ): Observable<Ok<'/api/v1/admin/reservations/{reservationId}/decline-cancellation', 'post'>> {
    return this.api.post(`/api/v1/admin/reservations/${reservationId}/decline-cancellation`, { reason });
  }

  /** A reservation at the counter (Phase 2B), optionally with its first cash payment. */
  createAtCounter(
    body: Body<'/api/v1/admin/reservations', 'post'>
  ): Observable<Ok<'/api/v1/admin/reservations', 'post'>> {
    return this.api.post('/api/v1/admin/reservations', body);
  }

  /** Cash at the counter for a live reservation. */
  registerCash(
    reservationId: string,
    amountCents: number
  ): Observable<Ok<'/api/v1/admin/reservations/{reservationId}/payments', 'post'>> {
    return this.api.post(`/api/v1/admin/reservations/${reservationId}/payments`, { amountCents });
  }

  /** Pays part of the reservation with its customer's credit. */
  applyCredit(
    reservationId: string,
    amountCents: number
  ): Observable<Ok<'/api/v1/admin/reservations/{reservationId}/apply-credit', 'post'>> {
    return this.api.post(`/api/v1/admin/reservations/${reservationId}/apply-credit`, { amountCents });
  }
}

type PendingVouchersQuery = NonNullable<paths['/api/v1/admin/payments']['get']['parameters']['query']>;

/** Payments for staff: the pending-vouchers queue and receipts (Phase 2B, download and resend). All need `payment.view`. */
@Injectable({ providedIn: 'root' })
export class AdminPaymentsApi {
  private readonly api = inject(ApiClient);

  /**
   * The OXXO and SPEI vouchers still waiting to be paid, soonest expiry first;
   * pass the previous page's `nextCursor` to continue. Never card intents.
   */
  pendingVouchers(
    query: Omit<PendingVouchersQuery, 'status'> = {}
  ): Observable<Ok<'/api/v1/admin/payments', 'get'>> {
    return this.api.get('/api/v1/admin/payments', {
      status: 'PENDING',
      method: query.method,
      cursor: query.cursor,
      limit: query.limit?.toString(),
    });
  }

  receipt(paymentId: string): Observable<Blob> {
    return this.api.getBlob(`/api/v1/admin/payments/${paymentId}/receipt`);
  }

  resendReceipt(paymentId: string): Observable<unknown> {
    return this.api.post(`/api/v1/admin/payments/${paymentId}/receipt/resend`, {});
  }
}

type CustomersQuery = NonNullable<paths['/api/v1/admin/customers']['get']['parameters']['query']>;

/** Customers at the counter (Phase 2B): search, register, invite, and their credit. */
@Injectable({ providedIn: 'root' })
export class CustomersApi {
  private readonly api = inject(ApiClient);

  search(query: CustomersQuery = {}): Observable<Ok<'/api/v1/admin/customers', 'get'>> {
    return this.api.get('/api/v1/admin/customers', {
      search: query.search,
      page: query.page?.toString(),
      pageSize: query.pageSize?.toString(),
    });
  }

  get(customerId: string): Observable<Ok<'/api/v1/admin/customers/{customerId}', 'get'>> {
    return this.api.get(`/api/v1/admin/customers/${customerId}`);
  }

  /** Fails with `CUSTOMER_ALREADY_EXISTS` (409) carrying `details.customerId` for an email already registered. */
  create(body: Body<'/api/v1/admin/customers', 'post'>): Observable<Ok<'/api/v1/admin/customers', 'post'>> {
    return this.api.post('/api/v1/admin/customers', body);
  }

  invite(customerId: string): Observable<Ok<'/api/v1/admin/customers/{customerId}/invitation', 'post'>> {
    return this.api.post(`/api/v1/admin/customers/${customerId}/invitation`, {});
  }

  credit(customerId: string): Observable<Ok<'/api/v1/admin/customers/{customerId}/credit', 'get'>> {
    return this.api.get(`/api/v1/admin/customers/${customerId}/credit`);
  }

  refundCredit(
    customerId: string,
    body: Body<'/api/v1/admin/customers/{customerId}/credit/refund', 'post'>
  ): Observable<Ok<'/api/v1/admin/customers/{customerId}/credit/refund', 'post'>> {
    return this.api.post(`/api/v1/admin/customers/${customerId}/credit/refund`, body);
  }

  adjustCredit(
    customerId: string,
    body: Body<'/api/v1/admin/customers/{customerId}/credit/adjust', 'post'>
  ): Observable<Ok<'/api/v1/admin/customers/{customerId}/credit/adjust', 'post'>> {
    return this.api.post(`/api/v1/admin/customers/${customerId}/credit/adjust`, body);
  }
}

/** Historical capture (Phase 2B, `data.backfill`). */
@Injectable({ providedIn: 'root' })
export class BackfillApi {
  private readonly api = inject(ApiClient);

  reservation(
    body: Body<'/api/v1/admin/backfill/reservations', 'post'>
  ): Observable<Ok<'/api/v1/admin/backfill/reservations', 'post'>> {
    return this.api.post('/api/v1/admin/backfill/reservations', body);
  }

  payments(
    body: Body<'/api/v1/admin/backfill/payments', 'post'>
  ): Observable<Ok<'/api/v1/admin/backfill/payments', 'post'>> {
    return this.api.post('/api/v1/admin/backfill/payments', body);
  }
}

/** CSV imports (Phase 2B, `import.manage`). */
@Injectable({ providedIn: 'root' })
export class ImportsApi {
  private readonly api = inject(ApiClient);

  list(): Observable<Ok<'/api/v1/admin/imports', 'get'>> {
    return this.api.get('/api/v1/admin/imports');
  }

  get(batchId: string): Observable<Ok<'/api/v1/admin/imports/{batchId}', 'get'>> {
    return this.api.get(`/api/v1/admin/imports/${batchId}`);
  }

  /** Validates without applying: the answer is the preview. */
  upload(body: Body<'/api/v1/admin/imports', 'post'>): Observable<Ok<'/api/v1/admin/imports', 'post'>> {
    return this.api.post('/api/v1/admin/imports', body);
  }

  apply(batchId: string): Observable<Ok<'/api/v1/admin/imports/{batchId}/apply', 'post'>> {
    return this.api.post(`/api/v1/admin/imports/${batchId}/apply`, {});
  }

  template(type: 'customers' | 'payments'): Observable<Blob> {
    return this.api.getBlob(`/api/v1/admin/imports/templates/${type}`);
  }
}

/** The agency details receipts print (Phase 2B, `settings.manage`). */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly api = inject(ApiClient);

  organization(): Observable<Ok<'/api/v1/admin/settings/organization', 'get'>> {
    return this.api.get('/api/v1/admin/settings/organization');
  }

  saveOrganization(
    body: Body<'/api/v1/admin/settings/organization', 'put'>
  ): Observable<Ok<'/api/v1/admin/settings/organization', 'put'>> {
    return this.api.put('/api/v1/admin/settings/organization', body);
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

  /** Phase 2B: what bringing the trip's current price to its reservations would do. `NO_PRICE_CHANGE` when nothing. */
  previewPriceChange(tripId: string): Observable<Ok<'/api/v1/trips/{tripId}/price-change', 'get'>> {
    return this.api.get(`/api/v1/trips/${tripId}/price-change`);
  }

  applyPriceChange(
    tripId: string,
    body: Body<'/api/v1/trips/{tripId}/price-change', 'post'>
  ): Observable<Ok<'/api/v1/trips/{tripId}/price-change', 'post'>> {
    return this.api.post(`/api/v1/trips/${tripId}/price-change`, body);
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
