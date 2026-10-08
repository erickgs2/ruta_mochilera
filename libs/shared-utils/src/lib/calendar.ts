import { DateTime } from 'luxon';
import { fail, ok, type Result } from './result';

/**
 * Counts how many first-of-month days fall strictly after `from` and on or
 * before `to`, evaluated in the given IANA timezone.
 *
 * This is the basis of the suggested monthly instalment: payments are made on
 * the 1st of each month, so this is the number of opportunities the customer
 * has left before the payment deadline. Purely informative — the system never
 * enforces a minimum monthly amount.
 */
export function monthStartsBetween(from: Date, to: Date, timeZone: string): number {
  const start = DateTime.fromJSDate(from, { zone: timeZone }).startOf('day');
  const end = DateTime.fromJSDate(to, { zone: timeZone }).startOf('day');
  if (end <= start) return 0;

  let cursor = start.startOf('month');
  if (cursor <= start) cursor = cursor.plus({ months: 1 });

  let count = 0;
  while (cursor <= end) {
    count += 1;
    cursor = cursor.plus({ months: 1 });
  }
  return count;
}

/**
 * The calendar day (`YYYY-MM-DD`) a date-only value stands for: the UTC date
 * part of the `Date`, which is exactly what Prisma stores in a `@db.Date`
 * column and what it reads back (UTC midnight of that day). Any time-of-day
 * a caller sent along (`2027-01-22T06:00:00Z`) is ignored, and the server's
 * own time zone plays no part. Two of these compare chronologically as plain
 * strings, which is how rules such as "the return is not before the
 * departure" should compare two `@db.Date` values.
 */
export function calendarDay(date: Date): string {
  const day = DateTime.fromJSDate(date, { zone: 'utc' }).toISODate();
  if (!day) throw new Error('calendarDay received an invalid Date');
  return day;
}

/**
 * True when `date` -- a date-only value such as a `@db.Date` column -- falls
 * on a calendar day strictly before "today" in the given IANA timezone,
 * where "today" is derived from `now`.
 *
 * Comparing calendar days, not instants, matters here: a `@db.Date` column
 * carries no time component (Prisma round-trips it as UTC midnight of that
 * calendar date), so comparing it against `now` directly with `<` is wrong
 * for part of the day in any timezone behind UTC. `America/Mexico_City` is
 * UTC-6, so for six hours after UTC midnight a trip departing "today" there
 * would be misclassified as past. Both sides are normalised to an ISO
 * calendar-date string before comparing so the comparison is between two
 * calendar-day labels, not two instants a fixed offset apart -- comparing the
 * underlying `DateTime` instants directly does not work, because `date` and
 * `now` anchor their "start of day" in different zones (UTC vs `timeZone`),
 * so the same calendar day produces two different instants depending on
 * which zone's midnight is used.
 */
export function isPastDate(date: Date, now: Date, timeZone: string): boolean {
  const day = DateTime.fromJSDate(date, { zone: 'utc' }).toISODate();
  const today = DateTime.fromJSDate(now, { zone: timeZone }).toISODate();
  if (!day || !today) throw new Error('isPastDate received an invalid Date');
  // ISO calendar-date strings ("YYYY-MM-DD") sort the same lexicographically
  // as chronologically, so plain string comparison is correct here.
  return day < today;
}

/**
 * Turns a date-only value -- a `@db.Date` column, which Prisma round-trips as
 * UTC midnight of that calendar date -- into an instant inside that same
 * calendar day in `timeZone`.
 *
 * Without this the deadline is read as an instant: in `America/Mexico_City`
 * (UTC-6), "1 March" arrives as 28 February at 18:00, and the month-start
 * count silently loses the customer's last payment opportunity. Same reason
 * `isPastDate` above compares calendar-day labels rather than instants.
 */
export function endOfCalendarDay(date: Date, timeZone: string): Date {
  const day = DateTime.fromJSDate(date, { zone: 'utc' }).toISODate();
  if (!day) throw new Error('endOfCalendarDay received an invalid Date');
  return DateTime.fromISO(day, { zone: timeZone }).endOf('day').toJSDate();
}

/**
 * True when `value` is a real calendar date written `YYYY-MM-DD` that is not
 * after `today` (also `YYYY-MM-DD`, already evaluated in the organization's
 * time zone by the caller). The one rule behind "no birth date or payment
 * date in the future" for both the counter and the CSV import.
 */
export function isCalendarDateNotAfter(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid && value <= today;
}

/**
 * The instant a historical record dated `date` (`YYYY-MM-DD`) is stamped at:
 * noon of that calendar day in `timeZone` -- never the day before or after --
 * but never later than `now`, because a backfilled payment or reservation
 * cannot be in the future (a date of today, captured before noon, is stamped
 * at the moment of capture). One rule for the CSV import and the backfill API.
 */
export function noonOrNow(date: string, timeZone: string, now: Date = new Date()): Date {
  const noon = DateTime.fromISO(date, { zone: timeZone }).set({ hour: 12 }).toJSDate();
  return noon.getTime() > now.getTime() ? now : noon;
}

/**
 * The dates of a historical capture (`YYYY-MM-DD`, as staff pick them) turned
 * into the instants the domain stores: noon of that day in the organization's
 * time zone, never later than `now` (`noonOrNow`). A date that is not a real
 * calendar date, or that is after today **in that zone**, is
 * `VALIDATION_FAILED` naming the first offending `field` -- the browser's own
 * time zone plays no part. The one rule behind the backfill API, which every
 * other caller (a job, the CSV import) inherits by going through the domain.
 */
export function resolveBackfillMoments(
  entries: { field: string; date: string }[],
  timeZone: string,
  now: Date = new Date()
): Result<Date[]> {
  const today = DateTime.fromJSDate(now, { zone: timeZone }).toISODate() as string;
  const moments: Date[] = [];
  for (const { field, date } of entries) {
    if (!isCalendarDateNotAfter(date, today)) return fail('VALIDATION_FAILED', { field });
    moments.push(noonOrNow(date, timeZone, now));
  }
  return ok(moments);
}
