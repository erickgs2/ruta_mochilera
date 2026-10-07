import { listInboxQuerySchema } from '@rm/contracts';
import { listInbox } from '@rm/domain-notifications';
import { fail } from '@rm/shared-utils';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

/**
 * The authenticated customer's own in-app inbox (`INBOX`-channel
 * deliveries only -- `listInbox`'s own doc comment in
 * `@rm/domain-notifications`), newest first, paginated by an opaque cursor.
 * No `permission`: the scope is ownership (`WHERE userId = actor.userId`),
 * not the RBAC catalogue that governs staff.
 *
 * **Query validation.** `route()` has no seam for validating query
 * parameters the way its `body` option validates a JSON body -- the
 * discriminated `RouteOptions` only ever parses `request.json()`, which a
 * GET request has none of. So the query string is parsed and validated here
 * by hand, against `listInboxQuerySchema` (`@rm/contracts`) -- the exact
 * same schema object `registry.ts` registers as this route's documented
 * query shape, so the OpenAPI document and the real validation cannot drift
 * apart the way an inline `Number(limitParam)` and a separately-typed-out
 * registry schema already had: a non-numeric `?limit=` used to coerce to
 * `NaN`, which `listInbox`'s own `Math.min(Math.max(limit ?? DEFAULT, 1),
 * MAX)` cannot clean up either (`??` does not catch `NaN`), and it reached
 * Prisma's `take` as a bare, unhandled 500.
 */
export const GET = route({
  handler: async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = listInboxQuerySchema.safeParse({
      cursor: params.get('cursor') ?? undefined,
      limit: params.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    return listInbox(db(), actor.userId, parsed.data);
  },
});
