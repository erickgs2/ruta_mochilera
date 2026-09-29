import { DateTime } from 'luxon';

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
