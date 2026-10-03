import { requireAnyPermission, requirePermission, type Actor, type PermissionKey } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { ZodType } from 'zod';
import { getActor } from './actor';
import { problemResponse } from './problem';

/**
 * `TActor` narrows per branch of `RouteOptions`: `null` for a public route,
 * `Actor` (non-nullable) for an authenticated one. This is what lets the
 * handler read `actor.userId` directly on an authenticated route instead of
 * every one of twenty endpoints writing `actor!` on the strength of a
 * convention.
 */
export interface RouteContext<TBody, TActor extends Actor | null> {
  actor: TActor;
  body: TBody;
  params: Record<string, string>;
  request: Request;
}

/**
 * Full override of the HTTP response, given the handler's complete `Result`
 * (success or failure) rather than just the success value. `route()` still
 * authenticates, checks the permission, validates the body and catches
 * unexpected exceptions -- this only replaces the final `toResponse` step.
 *
 * The only consumers today are `/auth/login`, `/auth/refresh` and
 * `/auth/logout`: the refresh token travels as an httpOnly, Secure,
 * SameSite=Strict cookie (see `lib/http/refresh-cookie.ts`), never in the
 * JSON body, which `toResponse`'s plain `Response.json(result.value, ...)`
 * cannot express. Everything else keeps using `successStatus`.
 */
export type RespondOverride<TResult> = (result: Result<TResult>, request: Request) => Response;

/** A route that skips authentication entirely. Cannot carry a permission: there is no actor to check it against. */
export interface PublicRouteOptions<TBody, TResult> {
  auth: 'public';
  /** Zod schema for the JSON request body. Omit for GET and DELETE. */
  body?: ZodType<TBody>;
  /** HTTP status on success. Defaults to 200. Ignored when `respond` is given. */
  successStatus?: number;
  /** See `RespondOverride`. */
  respond?: RespondOverride<TResult>;
  handler: (context: RouteContext<TBody, null>) => Promise<Result<TResult>>;
}

/** A route that requires an authenticated caller. This is the default when `auth` is omitted. */
export interface AuthenticatedRouteOptions<TBody, TResult> {
  auth?: 'required';
  /**
   * When set, the actor must hold this permission. Mutually exclusive with
   * `anyPermission` in practice (a route needs one shape of check or the
   * other), though both are independent optional fields rather than a
   * further discriminated union -- see `anyPermission`'s own doc comment for
   * why that extra type-level ceremony was not worth it here.
   */
  permission?: PermissionKey;
  /**
   * When set, the actor must hold at least one of these permissions. This is
   * the coarse entry gate for a route whose *exact* authorization a deeper
   * layer -- almost always the domain service the handler delegates to --
   * decides per request, the same way `PUT /trips/{tripId}/status` lets
   * anyone holding `trip.publish` or `trip.cancel` reach `changeTripStatus`,
   * which then requires `trip.cancel` specifically for a transition to
   * `CANCELLED` and `trip.publish` for every other one (see
   * `docs/business-rules/trips.md`).
   *
   * Kept as a sibling field to `permission`, not folded into it as
   * `PermissionKey | PermissionKey[]`: that shape is ambiguous about whether
   * an array means "all of" or "any of", and would have changed `permission`
   * itself for the ~20 endpoints that already use the single form. A second,
   * explicitly-named field changes nothing about those call sites.
   */
  anyPermission?: readonly PermissionKey[];
  /** Zod schema for the JSON request body. Omit for GET and DELETE. */
  body?: ZodType<TBody>;
  /** HTTP status on success. Defaults to 200. Ignored when `respond` is given. */
  successStatus?: number;
  /** See `RespondOverride`. */
  respond?: RespondOverride<TResult>;
  handler: (context: RouteContext<TBody, Actor>) => Promise<Result<TResult>>;
}

/**
 * A discriminated union on `auth` rather than one interface with an optional
 * `permission`: that shape used to let `{ auth: 'public', permission: X }`
 * compile and then lock the route for every caller with no diagnostic,
 * because a null actor can never hold a permission. Here that combination is
 * not a value this type can express, so it fails at the `route(...)` call
 * site instead of at request time.
 */
export type RouteOptions<TBody, TResult> =
  | PublicRouteOptions<TBody, TResult>
  | AuthenticatedRouteOptions<TBody, TResult>;

type NextRouteArgs = { params: Promise<Record<string, string>> };

/**
 * True when `request`'s `Content-Type` is `application/json`, optionally
 * with parameters such as a charset (`application/json; charset=utf-8` is
 * legitimate and must pass). Matched on the media type alone, case
 * insensitively, ignoring everything after the first `;`.
 */
function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type');
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

/**
 * Parses and validates the JSON body against `schema`, or returns
 * `undefined` immediately when there is none.
 *
 * The `Content-Type` check below exists for a reason that has nothing to do
 * with parsing correctness: `fetch` with `Content-Type: text/plain` is one
 * of the three CORS "safelisted" content types, so a cross-origin request
 * using it never triggers a preflight -- the browser just sends it. For most
 * endpoints that is merely sloppy (the handler still requires a valid access
 * token). But `POST /auth/login` is `auth: 'public'` and *sets* a cookie
 * rather than reading one, so `SameSite=Strict` -- which governs whether a
 * cookie is attached to an *outgoing* request, not whether an *incoming*
 * `Set-Cookie` gets stored -- does not protect it: a cross-site page can
 * submit the attacker's own credentials from the victim's browser via a
 * safelisted `text/plain` request, and the victim ends up silently inside
 * the attacker's account (a login CSRF, not a data leak).
 *
 * Requiring `application/json` closes that path: it is not a safelisted
 * value, so the browser must run a real CORS preflight (`OPTIONS`) first,
 * and this API answers no preflight permissively (see the CORS review in
 * `.superpowers/sdd/2026-09-28-fase-1-cimientos-panel-admin/csrf-fix-report.md`)
 * -- so the browser never sends the real cross-origin request at all. This
 * check runs before `request.json()` so a mislabelled body is rejected
 * without ever touching the handler.
 */
async function parseBody<TBody>(
  schema: ZodType<TBody> | undefined,
  request: Request
): Promise<Result<TBody>> {
  if (!schema) return ok(undefined as TBody);
  if (!hasJsonContentType(request)) {
    return fail('UNSUPPORTED_MEDIA_TYPE', { expected: 'application/json' });
  }
  const raw = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    });
  }
  return ok(parsed.data);
}

/**
 * Statuses the Fetch spec forbids from carrying a body (WHATWG "null body
 * status"). `Response.json(value, { status })` always serialises `value` into
 * a body -- even `Response.json(null, { status: 204 })` produces the 4-byte
 * body `"null"` -- so calling it with one of these statuses throws at
 * runtime regardless of what `value` is. A `DELETE` endpoint returning
 * `successStatus: 204` is exactly this case.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Turns a domain `Result` into the HTTP response: problem+json on failure, the value on success. */
function toResponse<TResult>(result: Result<TResult>, successStatus: number | undefined): Response {
  if (!result.ok) return problemResponse(result.error);
  const status = successStatus ?? 200;
  if (NULL_BODY_STATUSES.has(status)) return new Response(null, { status });
  return Response.json(result.value, { status });
}

/**
 * The only place HTTP concerns live. A handler authenticates, checks the
 * permission, validates the body and delegates to a domain service — nothing
 * else. Domain services never see a Request.
 *
 * The default is closed: omitting `auth` requires an authenticated caller
 * (`auth: 'public'` must be opted into explicitly), and a route is never
 * reachable with an unresolved permission check — `permission` and
 * `anyPermission`, when given, are each verified before the handler runs
 * (both, if both are somehow set); when neither is given, the route still
 * gates on authentication alone rather than falling through open.
 *
 * Identity is established before the permission is checked, and the two map
 * to different status codes: a caller with no valid token is 401
 * (`TOKEN_INVALID` — the client does not know who it is, and should refresh
 * or re-authenticate), while an identified caller who lacks the permission is
 * 403 (`PERMISSION_DENIED` — retrying with a fresh token will not help).
 * Collapsing both into 403, as an earlier version of this wrapper did, makes
 * an expired access token indistinguishable from a real authorization
 * failure and defeats the refresh-on-401 interceptor Task 16 builds on top of
 * this API.
 */
export function route<TBody = undefined, TResult = unknown>(
  options: RouteOptions<TBody, TResult>
) {
  return async (request: Request, context?: NextRouteArgs): Promise<Response> => {
    try {
      const params = context ? await context.params : {};

      if (options.auth === 'public') {
        const body = await parseBody(options.body, request);
        if (!body.ok) return problemResponse(body.error);
        const result = await options.handler({ actor: null, body: body.value, params, request });
        return options.respond ? options.respond(result, request) : toResponse(result, options.successStatus);
      }

      // Authenticate first: a null actor is always 401, whether or not this
      // route additionally requires a permission.
      const actor = await getActor(request);
      if (!actor) return problemResponse({ code: 'TOKEN_INVALID' });

      if (options.permission) {
        const allowed = requirePermission(actor, options.permission);
        if (!allowed.ok) return problemResponse(allowed.error);
      }
      if (options.anyPermission) {
        const allowed = requireAnyPermission(actor, options.anyPermission);
        if (!allowed.ok) return problemResponse(allowed.error);
      }

      const body = await parseBody(options.body, request);
      if (!body.ok) return problemResponse(body.error);
      const result = await options.handler({ actor, body: body.value, params, request });
      return options.respond ? options.respond(result, request) : toResponse(result, options.successStatus);
    } catch (error) {
      // Never let an unexpected exception escape as a bare stack trace to the
      // client. Logged server-side for diagnosis; the response carries only a
      // stable code, same as every other problem+json body.
      console.error('Unhandled route error', error);
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'INTERNAL_ERROR', status: 500, code: 'INTERNAL_ERROR' }),
        { status: 500, headers: { 'content-type': 'application/problem+json' } }
      );
    }
  };
}
