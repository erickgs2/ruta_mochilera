import { organizationTimeZone } from '@rm/domain-settings';
import { fail, isCalendarDateNotAfter, noonOrNow, ok, type Result } from '@rm/shared-utils';
import { DateTime } from 'luxon';
import { db } from './db';

/**
 * Turns the calendar dates of a historical capture (`YYYY-MM-DD`, as staff
 * pick them) into the instants the domain stores: noon of that day in the
 * organization's time zone, never later than now. A date after today in that
 * zone is `VALIDATION_FAILED` -- the browser's own time zone plays no part.
 * Same rule as the CSV import (`noonOrNow`).
 */
export async function backfillMoments(entries: { field: string; date: string }[]): Promise<Result<Date[]>> {
  const timeZone = await organizationTimeZone(db());
  const now = new Date();
  const today = DateTime.fromJSDate(now, { zone: timeZone }).toISODate() as string;
  const moments: Date[] = [];
  for (const { field, date } of entries) {
    if (!isCalendarDateNotAfter(date, today)) return fail('VALIDATION_FAILED', { field });
    moments.push(noonOrNow(date, timeZone, now));
  }
  return ok(moments);
}
