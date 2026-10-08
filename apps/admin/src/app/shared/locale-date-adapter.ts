import { effect, inject, Injectable, type Provider } from '@angular/core';
import {
  DateAdapter,
  MAT_DATE_FORMATS,
  MAT_DATE_LOCALE,
  MAT_NATIVE_DATE_FORMATS,
  NativeDateAdapter,
} from '@angular/material/core';
import { LanguageService, type AppLocale } from '@rm/i18n';

/** The BCP 47 tag the date adapter uses for each UI language. */
export function dateLocaleFor(language: AppLocale): string {
  return language === 'es' ? 'es-MX' : 'en-US';
}

const NUMERIC_DATE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/;

/**
 * Material's `NativeDateAdapter` with the day order of the interface language.
 *
 * Out of the box the native adapter prints the input with `Intl` (so the
 * locale already matters there) but **parses with `Date.parse`**, which reads
 * every `a/b/yyyy` as month/day: typing `22/01/2027` in the Spanish panel
 * gave an invalid date, and `01/02/2027` meant January 2nd. This adapter
 * parses and prints the input as dd/MM/yyyy for Spanish and M/d/yyyy for
 * English, and follows `LanguageService` when the language changes at
 * runtime. A date typed here is always built from its own year, month and
 * day -- local midnight, never an instant -- so no time zone can shift it.
 *
 * Calendar chrome (month and weekday names, first day of the week) still
 * comes from the base class through `Intl` for the same locale.
 */
@Injectable()
export class LocaleDateAdapter extends NativeDateAdapter {
  private readonly language = inject(LanguageService);
  private readonly formats = inject(MAT_DATE_FORMATS);

  constructor() {
    super();
    // The initial locale comes from `MAT_DATE_LOCALE` (see
    // `provideLocaleDateAdapter`); this keeps it in step afterwards, and
    // `setLocale` makes every open datepicker input re-render its value.
    effect(() => this.setLocale(dateLocaleFor(this.language.current())));
  }

  override parse(value: unknown): Date | null {
    if (typeof value !== 'string') return super.parse(value);
    const text = value.trim();
    if (text === '') return null;

    const match = NUMERIC_DATE.exec(text);
    if (!match) return this.invalid();
    const [first, second, third] = [match[1], match[2], match[3]];

    let year: number;
    let month: number;
    let day: number;
    if (first.length === 4) {
      // yyyy-MM-dd, which is what ISO strings and pasted API values look like.
      [year, month, day] = [Number(first), Number(second), Number(third)];
    } else if (third.length === 4) {
      year = Number(third);
      [month, day] = this.isDayFirst() ? [Number(second), Number(first)] : [Number(first), Number(second)];
    } else {
      // A two-digit year would be guessed into a century; ask for all four.
      return this.invalid();
    }

    const date = new Date(year, month - 1, day);
    // `new Date(2027, 1, 31)` rolls over into March: only a date that comes
    // back with the same parts was a real calendar day.
    const exists = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    return exists ? date : this.invalid();
  }

  override format(date: Date, displayFormat: object): string {
    if (displayFormat !== this.formats.display.dateInput) return super.format(date, displayFormat);
    if (!this.isValid(date)) throw Error('LocaleDateAdapter: cannot format an invalid date.');

    const day = this.getDate(date);
    const month = this.getMonth(date) + 1;
    const year = String(this.getYear(date)).padStart(4, '0');
    return this.isDayFirst() ? `${pad(day)}/${pad(month)}/${year}` : `${month}/${day}/${year}`;
  }

  private isDayFirst(): boolean {
    return String(this.locale).startsWith('es');
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Replaces `provideNativeDateAdapter()` for the panel: a date adapter that
 * follows the active UI language (`es` -> es-MX, `en` -> en-US).
 */
export function provideLocaleDateAdapter(): Provider[] {
  return [
    { provide: MAT_DATE_LOCALE, useFactory: () => dateLocaleFor(inject(LanguageService).current()) },
    { provide: DateAdapter, useClass: LocaleDateAdapter },
    { provide: MAT_DATE_FORMATS, useValue: MAT_NATIVE_DATE_FORMATS },
  ];
}
