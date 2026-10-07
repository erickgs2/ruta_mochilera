import { formatDate } from '@angular/common';
import { inject, Pipe, type PipeTransform } from '@angular/core';
import { LanguageService } from './language.service';
// Registers the Spanish formatting data, once, as a side effect.
import './calendar-date.pipe';

/**
 * Renders a real instant -- a `timestamptz` such as when a payment was
 * recorded -- in the viewer's time zone and the interface's language
 * ("7 oct 2026, 5:04" / "Oct 7, 2026, 5:04 AM"). The counterpart of
 * `rmCalendarDate`, which is for calendar days. Angular's `DatePipe` would
 * use `LOCALE_ID`, which nothing sets, and leave every date in English.
 * Impure for the same reason as `rmCalendarDate`: the language can change.
 */
@Pipe({ name: 'rmDateTime', standalone: true, pure: false })
export class DateTimePipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(value: string | Date | null | undefined, format = 'medium'): string {
    if (value === null || value === undefined || value === '') return '';
    return formatDate(value, format, this.language.current());
  }
}
