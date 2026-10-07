import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { DateTimePipe } from './date-time.pipe';
import { LanguageService } from './language.service';

describe('DateTimePipe', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' })] });
  });

  it('writes an instant in the interface language', () => {
    const pipe = TestBed.runInInjectionContext(() => new DateTimePipe());
    const language = TestBed.inject(LanguageService);

    language.use('es');
    expect(pipe.transform('2026-10-07T17:04:00.000Z', 'mediumDate')).toBe('7 oct 2026');
    language.use('en');
    expect(pipe.transform('2026-10-07T17:04:00.000Z', 'mediumDate')).toBe('Oct 7, 2026');
  });

  it('renders nothing for a missing value', () => {
    const pipe = TestBed.runInInjectionContext(() => new DateTimePipe());
    expect(pipe.transform(null)).toBe('');
  });
});
