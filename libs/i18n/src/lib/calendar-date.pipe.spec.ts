import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { CalendarDatePipe } from './calendar-date.pipe';
import { LanguageService } from './language.service';

describe('CalendarDatePipe', () => {
  let pipe: CalendarDatePipe;
  let previousTimeZone: string | undefined;

  beforeEach(() => {
    // A zone west of UTC is where the midnight-UTC serialization of a
    // `@db.Date` would slip to the previous day. Node re-reads TZ on
    // assignment, so this holds regardless of the machine running the suite.
    previousTimeZone = process.env['TZ'];
    process.env['TZ'] = 'America/Mexico_City';
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' })] });
    TestBed.inject(LanguageService).use('es');
    pipe = TestBed.runInInjectionContext(() => new CalendarDatePipe());
  });

  afterEach(() => {
    if (previousTimeZone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previousTimeZone;
  });

  it('renders a midnight-UTC calendar date as the stored day for a viewer west of UTC', () => {
    expect(pipe.transform('2026-11-20T00:00:00.000Z')).toBe('20 nov 2026');
  });

  it('writes the date in the language the interface is in, and follows a switch', () => {
    expect(pipe.transform('2027-01-23T00:00:00.000Z')).toBe('23 ene 2027');

    TestBed.inject(LanguageService).use('en');

    expect(pipe.transform('2027-01-23T00:00:00.000Z')).toBe('Jan 23, 2027');
  });

  it('accepts a custom format', () => {
    expect(pipe.transform('2026-11-20T00:00:00.000Z', 'yyyy-MM-dd')).toBe('2026-11-20');
  });

  it('returns an empty string for null, undefined or an empty string', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('')).toBe('');
  });
});
