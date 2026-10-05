import { listInbox } from '@rm/domain-notifications';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

/**
 * The authenticated customer's own in-app inbox (`INBOX`-channel
 * deliveries only -- `listInbox`'s own doc comment in
 * `@rm/domain-notifications`), newest first, paginated by an opaque cursor.
 * No `permission`: the scope is ownership (`WHERE userId = actor.userId`),
 * not the RBAC catalogue that governs staff.
 */
export const GET = route({
  handler: async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const limitParam = params.get('limit');
    return listInbox(db(), actor.userId, {
      cursor: params.get('cursor') ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    });
  },
});
