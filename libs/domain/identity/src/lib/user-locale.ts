import type { Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import { describeUser, type AuthenticatedUser } from './auth-service';

/**
 * Saves the caller's own language (`User.locale`) -- for staff and customers
 * alike -- and returns the user as a session describes them. The language is a
 * per-user preference that also drives the text of emails, receipts and
 * notifications, which read it from this row when they are written.
 *
 * Self only by construction: it takes the caller's id, never another user's.
 * The access token still carries the old `locale` claim until the next refresh;
 * nothing on the server reads that claim to choose a language.
 */
export async function updateOwnLocale(db: Db, userId: string, locale: 'es' | 'en'): Promise<Result<AuthenticatedUser>> {
  const updated = await db.user.updateMany({ where: { id: userId }, data: { locale } });
  if (updated.count === 0) return fail('NOT_FOUND');
  return ok(await describeUser(db, userId));
}
