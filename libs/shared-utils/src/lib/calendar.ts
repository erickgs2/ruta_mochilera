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
