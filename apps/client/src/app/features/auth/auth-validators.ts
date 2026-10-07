import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/**
 * Stricter than Angular's `Validators.email`, which accepts `ana@example`:
 * the API's `z.string().email()` rejects an address with no dot in the
 * domain, and catching that here saves a round trip that would only come
 * back as `VALIDATION_FAILED`.
 */
export const emailAddress: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = String(control.value ?? '');
  return value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : { emailAddress: true };
};

/**
 * A real `YYYY-MM-DD` calendar date (so `1990-02-31` fails), no later than
 * today and no earlier than 1900-01-01. "Today" is the device's local date,
 * which is the date the person typing it thinks in.
 */
export const pastIsoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = String(control.value ?? '');
  if (value === '') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { pastIsoDate: true };
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  const isRealDate = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return isRealDate && year >= 1900 && date <= today ? null : { pastIsoDate: true };
};
