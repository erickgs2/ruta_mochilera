import { markAllRead } from '@rm/domain-notifications';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/**
 * Marks every unread INBOX delivery of the authenticated user as read -- the
 * staff panel's "mark all read". Like `GET /notifications`, no `permission`:
 * the scope is ownership (`markAllRead` touches only `actor.userId`'s rows).
 * No response body.
 */
export const POST = route({
  successStatus: 204,
  handler: async ({ actor }) => markAllRead(db(), actor.userId),
});
