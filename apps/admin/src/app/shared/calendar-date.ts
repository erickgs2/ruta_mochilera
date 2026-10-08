/**
 * A trip's departure, return and payment deadline are calendar days
 * (`@db.Date`): the API sends them as midnight UTC ("2027-01-22T00:00:00.000Z")
 * and reads them back the same way. A datepicker works with a `Date` at
 * *local* midnight. Converting with `new Date(iso)` / `date.toISOString()`
 * moves the day in any zone other than UTC -- in America/Mexico_City (UTC-6)
 * the stored 22nd would open as the 21st -- so both directions go through the
 * year, month and day instead.
 */

/** The `Date` (local midnight) a datepicker should show for an API calendar date. */
export function toPickerDate(apiDate: string): Date {
  const stored = new Date(apiDate);
  return new Date(stored.getUTCFullYear(), stored.getUTCMonth(), stored.getUTCDate());
}

/** The API calendar date (midnight UTC) for the day a datepicker holds. */
export function toApiDate(pickerDate: Date): string {
  return new Date(Date.UTC(pickerDate.getFullYear(), pickerDate.getMonth(), pickerDate.getDate())).toISOString();
}
