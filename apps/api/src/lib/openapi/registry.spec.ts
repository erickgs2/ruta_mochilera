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
  '/api/v1/me',
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
  '/api/v1/files/{key}',
  '/api/v1/webhooks/stripe',
];

/**
 * The routes that are deliberately not gated on a token: the three auth
 * endpoints that issue one, the local file server, and Stripe's webhook --
 * which is authorised by an HMAC over the request body, not by an actor,
 * and therefore has no 401 or 403 to document.
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
  '/api/v1/files/{key}',
  '/api/v1/webhooks/stripe',
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
        // /api/v1/me is authenticated but does not gate on a permission, so it
        // never returns 403 -- every other gated route requires a permission.
        if (path !== '/api/v1/me') {
          expect(operation.responses['403'], `${path} is missing 403`).toBeDefined();
        }
      }
    }
  });
});
