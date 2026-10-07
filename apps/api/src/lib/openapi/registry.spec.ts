import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './registry';

/**
 * One path template per `route.ts` file under `apps/api/src/app/api/v1/**`.
 * Kept as an explicit list (rather than only `expect.arrayContaining`) so a
 * new route file that is never registered here fails this test loudly,
 * instead of silently shipping an Angular client that cannot call it.
 */
const EVERY_ROUTE_FILE_PATH = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-code',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/oauth/google',
  '/api/v1/auth/oauth/apple',
  '/api/v1/auth/invitation/accept',
  '/api/v1/admin/customers',
  '/api/v1/admin/customers/{customerId}',
  '/api/v1/admin/customers/{customerId}/invitation',
  '/api/v1/me',
  '/api/v1/me/profile',
  '/api/v1/me/profile/photo',
  '/api/v1/rbac/permissions',
  '/api/v1/rbac/roles',
  '/api/v1/rbac/roles/{roleId}',
  '/api/v1/staff',
  '/api/v1/staff/{userId}',
  '/api/v1/trips',
  '/api/v1/trips/{tripId}',
  '/api/v1/trips/{tripId}/status',
  '/api/v1/trips/{tripId}/images',
  '/api/v1/trips/{tripId}/images/{imageId}',
  '/api/v1/trips/{tripId}/costing',
  '/api/v1/trips/{tripId}/costing/items',
  '/api/v1/trips/{tripId}/costing/items/{itemId}',
  '/api/v1/trips/{tripId}/price-change',
  '/api/v1/files/{key}',
  '/api/v1/webhooks/stripe',
  '/api/v1/public/trips',
  '/api/v1/public/trips/{slug}',
  '/api/v1/reservations',
  '/api/v1/reservations/{reservationId}',
  '/api/v1/reservations/{reservationId}/cancellation-requests',
  '/api/v1/reservations/{reservationId}/payment-intents',
  '/api/v1/admin/reservations',
  '/api/v1/admin/reservations/{reservationId}',
  '/api/v1/admin/reservations/{reservationId}/payments',
  '/api/v1/admin/reservations/{reservationId}/cancel',
  '/api/v1/admin/reservations/{reservationId}/decline-cancellation',
  '/api/v1/admin/reservations/{reservationId}/apply-credit',
  '/api/v1/admin/customers/{customerId}/credit',
  '/api/v1/admin/customers/{customerId}/credit/refund',
  '/api/v1/admin/customers/{customerId}/credit/adjust',
  '/api/v1/me/credit',
  '/api/v1/admin/payments/{paymentId}/receipt',
  '/api/v1/admin/payments/{paymentId}/receipt/resend',
  '/api/v1/payments/{paymentId}/receipt',
  '/api/v1/payments',
  '/api/v1/notifications',
  '/api/v1/notifications/{deliveryId}/read',
];

/**
 * The routes that are deliberately not gated on a token: the three auth
 * endpoints that issue one, the two social sign-in endpoints (Task 13,
 * `auth: 'public'` the same as `/auth/login`), the local file server, and
 * Stripe's webhook -- which is authorised by an HMAC over the request body,
 * not by an actor, and therefore has no 401 or 403 to document.
 */
const UNGATED_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-code',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/oauth/google',
  '/api/v1/auth/oauth/apple',
  '/api/v1/auth/invitation/accept',
  '/api/v1/files/{key}',
  '/api/v1/webhooks/stripe',
  '/api/v1/public/trips',
  '/api/v1/public/trips/{slug}',
];

/**
 * Routes that require a valid access token but check no permission from the
 * RBAC catalogue at all -- `/api/v1/me` (there is no "view your own
 * profile" permission to hold), and every customer-facing reservations /
 * payments / notifications endpoint Task 14 adds: those are gated on
 * ownership (a reservation or inbox delivery belonging to the caller),
 * never on a permission a STAFF role could hold or lack, so none of them
 * can ever answer 403. See `docs/business-rules/reservations.md` and this
 * task's own doc comments in each `route.ts` for why that check lives in
 * the domain rather than as a route-level `permission`.
 */
const NO_PERMISSION_CHECK_PATHS = [
  '/api/v1/me',
  '/api/v1/me/profile',
  '/api/v1/me/profile/photo',
  '/api/v1/me/credit',
  '/api/v1/reservations',
  '/api/v1/reservations/{reservationId}',
  '/api/v1/reservations/{reservationId}/cancellation-requests',
  '/api/v1/reservations/{reservationId}/payment-intents',
  '/api/v1/payments',
  '/api/v1/payments/{paymentId}/receipt',
  '/api/v1/notifications',
  '/api/v1/notifications/{deliveryId}/read',
];

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument();

  it('declares bearer authentication', () => {
    expect(document.components?.securitySchemes?.['bearerAuth']).toBeDefined();
  });

  it('documents every route file under apps/api/src/app/api/v1', () => {
    const paths = Object.keys(document.paths ?? {});
    expect(paths.sort()).toEqual([...EVERY_ROUTE_FILE_PATH].sort());
  });

  it('registers the reusable schemas as named components', () => {
    const schemas = document.components?.schemas ?? {};
    for (const name of ['Permission', 'Role', 'Staff', 'Session', 'Problem', 'Trip', 'TripCosting']) {
      expect(schemas[name]).toBeDefined();
    }
  });

  it('documents problem+json on a public failure response', () => {
    const login = document.paths?.['/api/v1/auth/login']?.post?.responses?.['401'];
    expect(login?.content?.['application/problem+json']).toBeDefined();
  });

  it('documents both 401 and 403 on every gated route, so the client can tell an expired token apart from a real permission failure', () => {
    const gatedPaths = EVERY_ROUTE_FILE_PATH.filter((path) => !UNGATED_PATHS.includes(path));

    for (const path of gatedPaths) {
      const operations = Object.values(document.paths?.[path] ?? {}).filter(
        (operation): operation is NonNullable<typeof operation> & { responses: Record<string, unknown> } =>
          typeof operation === 'object' && operation !== null && 'responses' in operation
      );
      for (const operation of operations) {
        expect(operation.responses['401'], `${path} is missing 401`).toBeDefined();
        // See `NO_PERMISSION_CHECK_PATHS`: these are authenticated but gate
        // on ownership, never on a permission, so none of them can ever
        // return 403.
        if (!NO_PERMISSION_CHECK_PATHS.includes(path)) {
          expect(operation.responses['403'], `${path} is missing 403`).toBeDefined();
        }
      }
    }
  });
});
