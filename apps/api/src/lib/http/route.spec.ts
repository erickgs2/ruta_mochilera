import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ok } from '@rm/shared-utils';
import type { Actor, PermissionKey } from '@rm/domain-rbac';

// `route()` resolves the caller through `getActor`, which itself hits the
// database via `db()`. Mocking it here keeps this suite a pure unit test of
// `route()`'s own branching (auth, permission, body, delegate) instead of an
// integration test of token verification or user lookup -- those are covered
// separately in `auth.integration.spec.ts` and belong to `actor.ts`.
vi.mock('./actor', () => ({ getActor: vi.fn() }));

import { getActor } from './actor';
import { route } from './route';

const mockedGetActor = vi.mocked(getActor);

function staffActor(permissions: PermissionKey[] = []): Actor {
  return { userId: 'staff-1', type: 'STAFF', locale: 'es', permissions };
}

function customerActor(permissions: PermissionKey[] = []): Actor {
  return { userId: 'customer-1', type: 'CUSTOMER', locale: 'es', permissions };
}

describe('route', () => {
  beforeEach(() => {
    mockedGetActor.mockReset();
  });

  it('requires authentication by default (closed default)', async () => {
    mockedGetActor.mockResolvedValue(null);
    const handler = vi.fn(async () => ok('unreachable'));
    const endpoint = route({ handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('TOKEN_INVALID');
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips authentication entirely for a public route', async () => {
    const handler = vi.fn(async (ctx: { actor: Actor | null }) => ok({ actor: ctx.actor }));
    const endpoint = route({ auth: 'public', handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(mockedGetActor).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect((await response.json()).actor).toBeNull();
  });

  it('allows an authenticated actor when no permission is required', async () => {
    mockedGetActor.mockResolvedValue(staffActor());
    const handler = vi.fn(async (ctx: { actor: Actor }) => ok({ id: ctx.actor.userId }));
    const endpoint = route({ handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe('staff-1');
  });

  it('allows an actor holding the required permission', async () => {
    mockedGetActor.mockResolvedValue(staffActor(['trip.view']));
    const handler = vi.fn(async () => ok('granted'));
    const endpoint = route({ permission: 'trip.view', handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(200);
    expect(await response.json()).toBe('granted');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('denies an actor missing the required permission with 403, not 401', async () => {
    mockedGetActor.mockResolvedValue(staffActor([]));
    const handler = vi.fn(async () => ok('unreachable'));
    const endpoint = route({ permission: 'trip.view', handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('PERMISSION_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 TOKEN_INVALID, not 403, for an unauthenticated caller even when a permission is required', async () => {
    // This is the regression this fix round exists for: an expired or
    // missing token must read as "I don't know who you are" (401), never as
    // "you may not do this" (403) -- otherwise a client's refresh-on-401
    // logic never fires on a protected endpoint.
    mockedGetActor.mockResolvedValue(null);
    const handler = vi.fn(async () => ok('unreachable'));
    const endpoint = route({ permission: 'trip.view', handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('TOKEN_INVALID');
    expect(handler).not.toHaveBeenCalled();
  });

  it('denies a customer actor even if it carries a matching permission key', async () => {
    // Customers never hold staff permissions by construction, but this
    // guards the check itself: even a customer actor whose `permissions`
    // array happens to contain the key must still be denied.
    mockedGetActor.mockResolvedValue(customerActor(['trip.view']));
    const handler = vi.fn(async () => ok('unreachable'));
    const endpoint = route({ permission: 'trip.view', handler });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('PERMISSION_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 422 when the body fails validation, before the handler runs', async () => {
    mockedGetActor.mockResolvedValue(staffActor());
    const handler = vi.fn(async () => ok('unreachable'));
    const endpoint = route({ body: z.object({ name: z.string() }), handler });

    const response = await endpoint(
      new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({}) })
    );

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a generic problem+json 500 without leaking details when the handler throws', async () => {
    mockedGetActor.mockResolvedValue(staffActor());
    const endpoint = route({
      handler: async () => {
        throw new Error('boom, with a stack trace and secrets');
      },
    });

    const response = await endpoint(new Request('http://localhost/x'));

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = await response.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body).not.toHaveProperty('message');
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('returns a bodyless 204 when successStatus is 204, even though the handler resolves a value', async () => {
    // Regression test: `Response.json(value, { status: 204 })` throws at
    // runtime for any `value` (including `null`), because the Fetch spec
    // forbids a body on a null-body status. A DELETE endpoint returning
    // `successStatus: 204` must not go through `Response.json` at all.
    mockedGetActor.mockResolvedValue(staffActor());
    const handler = vi.fn(async () => ok(null));
    const endpoint = route({ successStatus: 204, handler });

    const response = await endpoint(new Request('http://localhost/x', { method: 'DELETE' }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('rejects at compile time: a public route cannot declare a permission', () => {
    // This body never runs any meaningful assertion; the check is the
    // `@ts-expect-error` itself. If `{ auth: 'public', permission: ... }`
    // ever starts compiling -- a public route has no actor, so it could
    // never satisfy a permission check -- this directive becomes a compile
    // error on its own and `pnpm nx run-many -t typecheck` fails.
    // @ts-expect-error -- a public route has no actor, so it can never satisfy a permission check
    route({ auth: 'public', permission: 'trip.view', handler: async () => ok(null) });
  });
});
