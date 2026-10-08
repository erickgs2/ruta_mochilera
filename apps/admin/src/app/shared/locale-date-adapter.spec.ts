import { TestBed } from '@angular/core/testing';
import { DateAdapter, MAT_DATE_FORMATS, MAT_DATE_LOCALE } from '@angular/material/core';
import { provideTranslateService } from '@ngx-translate/core';
import { LanguageService } from '@rm/i18n';
import { toApiDate, toPickerDate } from './calendar-date';
import { LocaleDateAdapter, provideLocaleDateAdapter } from './locale-date-adapter';

function setup(language: 'es' | 'en') {
  localStorage.setItem('rm.locale', language);
  TestBed.configureTestingModule({
    providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' }), provideLocaleDateAdapter()],
  });
  const adapter = TestBed.inject(DateAdapter) as LocaleDateAdapter;
  const dateInput = TestBed.inject(MAT_DATE_FORMATS).display.dateInput;
  return { adapter, dateInput, language: TestBed.inject(LanguageService) };
}

function parts(date: Date | null): number[] | null {
  return date && [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

describe('LocaleDateAdapter', () => {
  afterEach(() => localStorage.clear());

  it('runs the suite in America/Mexico_City, the zone these checks are about', () => {
    // January: Mexico City has no daylight saving time, so this is UTC-6.
    expect(new Date(2027, 0, 22).getTimezoneOffset()).toBe(360);
  });

  describe('Spanish', () => {
    it('starts on the es-MX locale and prints the input as dd/MM/yyyy', () => {
      const { adapter, dateInput } = setup('es');

      expect(TestBed.inject(MAT_DATE_LOCALE)).toBe('es-MX');
      expect(adapter.format(new Date(2027, 0, 22), dateInput)).toBe('22/01/2027');
      expect(adapter.format(new Date(2027, 11, 3), dateInput)).toBe('03/12/2027');
    });

    it('reads typed input day first: 22/01/2027 is January 22nd, never an invalid date or October 1st', () => {
      const { adapter } = setup('es');

      expect(parts(adapter.parse('22/01/2027'))).toEqual([2027, 1, 22]);
      expect(parts(adapter.parse('01/02/2027'))).toEqual([2027, 2, 1]);
      expect(parts(adapter.parse(' 5-3-2027 '))).toEqual([2027, 3, 5]);
      expect(parts(adapter.parse('2027-01-22'))).toEqual([2027, 1, 22]);
    });

    it('rejects what is not a real calendar day instead of rolling it over', () => {
      const { adapter } = setup('es');

      for (const text of ['31/02/2027', '22/13/2027', '00/01/2027', '1/22/2027', '22/01/27', 'enero', '22/01']) {
        expect(adapter.isValid(adapter.parse(text) as Date)).toBe(false);
      }
      expect(adapter.parse('')).toBeNull();
      expect(adapter.parse('   ')).toBeNull();
    });
  });

  describe('English', () => {
    it('starts on en-US and prints and reads month first', () => {
      const { adapter, dateInput } = setup('en');

      expect(TestBed.inject(MAT_DATE_LOCALE)).toBe('en-US');
      expect(adapter.format(new Date(2027, 0, 22), dateInput)).toBe('1/22/2027');
      expect(parts(adapter.parse('1/22/2027'))).toEqual([2027, 1, 22]);
      expect(parts(adapter.parse('01/02/2027'))).toEqual([2027, 1, 2]);
      expect(adapter.isValid(adapter.parse('22/01/2027') as Date)).toBe(false);
    });
  });

  it('follows the interface language when it changes at runtime', () => {
    const { adapter, dateInput, language } = setup('es');
    const date = new Date(2027, 0, 22);
    TestBed.tick();
    expect(adapter.format(date, dateInput)).toBe('22/01/2027');

    language.use('en');
    TestBed.tick();
    expect(adapter.format(date, dateInput)).toBe('1/22/2027');
    expect(parts(adapter.parse('01/02/2027'))).toEqual([2027, 1, 2]);

    language.use('es');
    TestBed.tick();
    expect(adapter.format(date, dateInput)).toBe('22/01/2027');
    expect(parts(adapter.parse('01/02/2027'))).toEqual([2027, 2, 1]);
  });

  it('tells open datepicker inputs to re-render when the language changes', () => {
    const { adapter, language } = setup('es');
    TestBed.tick();
    let changes = 0;
    adapter.localeChanges.subscribe(() => changes++);

    language.use('en');
    TestBed.tick();

    expect(changes).toBe(1);
  });

  it('leaves the calendar chrome (month and weekday names) to the base adapter for the same locale', () => {
    const { adapter } = setup('es');

    expect(adapter.getMonthNames('long')[0].toLowerCase()).toBe('enero');
  });
});

describe('calendar dates in America/Mexico_City', () => {
  afterEach(() => localStorage.clear());

  it('opens the stored day, not the day before (the API sends a @db.Date as midnight UTC)', () => {
    const { adapter, dateInput } = setup('es');
    const picked = toPickerDate('2027-01-22T00:00:00.000Z');

    expect(parts(picked)).toEqual([2027, 1, 22]);
    expect(adapter.format(picked, dateInput)).toBe('22/01/2027');
  });

  it('sends the day that was typed as midnight UTC, whatever the zone', () => {
    const { adapter } = setup('es');

    expect(toApiDate(adapter.parse('22/01/2027') as Date)).toBe('2027-01-22T00:00:00.000Z');
    expect(toApiDate(new Date(2027, 11, 31))).toBe('2027-12-31T00:00:00.000Z');
  });

  it('round-trips every day of a leap year without an off-by-one', () => {
    for (let day = 0; day < 366; day++) {
      const stored = new Date(Date.UTC(2028, 0, 1 + day)).toISOString();
      expect(toApiDate(toPickerDate(stored))).toBe(stored);
    }
  });

  it('round-trips through the typed text: stored -> shown -> typed back -> stored', () => {
    const { adapter, dateInput } = setup('es');
    for (const stored of ['2027-01-01T00:00:00.000Z', '2027-03-31T00:00:00.000Z', '2027-12-31T00:00:00.000Z']) {
      const shown = adapter.format(toPickerDate(stored), dateInput);
      expect(toApiDate(adapter.parse(shown) as Date)).toBe(stored);
    }
  });
});
