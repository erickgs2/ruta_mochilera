import { requirePermission, type Actor, type PermissionKey } from '@rm/domain-rbac';
import { type Result } from '@rm/shared-utils';
import type { ZodType } from 'zod';
import { getActor } from './actor';
import { problemResponse } from './problem';

export interface RouteContext<TBody> {
  actor: Actor | null;
  body: TBody;
  params: Record<string, string>;
  request: Request;
}

export interface RouteOptions<TBody, TResult> {
  /** 'public' skips authentication entirely. Defaults to 'required'. */
  auth?: 'required' | 'public';
  /** When set, the actor must hold this permission. Implies auth: 'required'. */
  permission?: PermissionKey;
  /** Zod schema for the JSON request body. Omit for GET and DELETE. */
  body?: ZodType<TBody>;
  /** HTTP status on success. Defaults to 200. */
  successStatus?: number;
  handler: (context: RouteContext<TBody>) => Promise<Result<TResult>>;
}

type NextRouteArgs = { params: Promise<Record<string, string>> };

/**
 * The only place HTTP concerns live. A handler authenticates, checks the
 * permission, validates the body and delegates to a domain service — nothing
 * else. Domain services never see a Request.
 *
 * The default is closed: omitting `auth` requires an authenticated caller
 * (`auth: 'public'` must be opted into explicitly), and a route is never
 * reachable with an unresolved permission check — `permission`, when given,
 * is verified before the handler runs; when omitted, the route still gates
 * on authentication alone rather than falling through open.
 */
export function route<TBody = undefined, TResult = unknown>(
  options: RouteOptions<TBody, TResult>
) {
  return async (request: Request, context?: NextRouteArgs): Promise<Response> => {
    try {
      const actor = options.auth === 'public' ? null : await getActor(request);

      if (options.permission) {
        const allowed = requirePermission(actor, options.permission);
        if (!allowed.ok) return problemResponse(allowed.error);
      } else if (options.auth !== 'public' && !actor) {
        return problemResponse({ code: 'TOKEN_INVALID' });
      }

      let body = undefined as TBody;
      if (options.body) {
        const raw = await request.json().catch(() => undefined);
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) {
          return problemResponse({
            code: 'VALIDATION_FAILED',
            details: { issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })) },
          });
        }
        body = parsed.data;
      }

      const params = context ? await context.params : {};
      const result = await options.handler({ actor, body, params, request });

      if (!result.ok) return problemResponse(result.error);
      return Response.json(result.value, { status: options.successStatus ?? 200 });
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
