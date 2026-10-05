import { formatDate } from '@angular/common';
import { inject, LOCALE_ID, Pipe, type PipeTransform } from '@angular/core';

/**
 * Renders a calendar date -- a `@db.Date` column such as a trip's departure
 * or return date -- as that same day, whatever the viewer's time zone.
 *
 * The API serializes a `@db.Date` as midnight UTC ("2026-11-20T00:00:00.000Z").
 * Angular's `DatePipe` converts to the device's zone by default, so a viewer
 * west of UTC (America/Mexico_City is UTC-6) would see the day before.
 * Formatting in UTC shows the stored day. Use `DatePipe` for real instants
 * (`timestamptz`), which should follow the viewer's zone.
 */
@Pipe({ name: 'rmCalendarDate', standalone: true })
export class CalendarDatePipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(value: string | Date | null | undefined, format = 'mediumDate'): string {
    if (value === null || value === undefined || value === '') return '';
    return formatDate(value, format, this.locale, 'UTC');
  }
}
