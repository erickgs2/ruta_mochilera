import { formatDate, registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';
import { inject, Pipe, type PipeTransform } from '@angular/core';
import { LanguageService } from './language.service';

// Angular ships only en-US formatting data; Spanish has to be registered
// before `formatDate` can use it.
registerLocaleData(localeEs);

/**
 * Renders a calendar date -- a `@db.Date` column such as a trip's departure
 * or return date -- as that same day, whatever the viewer's time zone.
 *
 * The API serializes a `@db.Date` as midnight UTC ("2026-11-20T00:00:00.000Z").
 * Angular's `DatePipe` converts to the device's zone by default, so a viewer
 * west of UTC (America/Mexico_City is UTC-6) would see the day before.
 * Formatting in UTC shows the stored day. Use `DatePipe` for real instants
 * (`timestamptz`), which should follow the viewer's zone.
 *
 * Written in the interface's language ("20 nov 2026" / "Nov 20, 2026"), read
 * from `LanguageService` like `rmMoney` -- not from `LOCALE_ID`, which nothing
 * sets and which would leave every date in English. Impure for the same
 * reason as `rmMoney`: the language is a signal that can change at runtime.
 */
@Pipe({ name: 'rmCalendarDate', standalone: true, pure: false })
export class CalendarDatePipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(value: string | Date | null | undefined, format = 'mediumDate'): string {
    if (value === null || value === undefined || value === '') return '';
    return formatDate(value, format, this.language.current(), 'UTC');
  }
}
