import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { LanguageService } from '@rm/i18n';
import { MoneyPipe } from './money.pipe';

describe('MoneyPipe', () => {
  let pipe: MoneyPipe;
  let language: LanguageService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideTranslateService()],
    });
    language = TestBed.inject(LanguageService);
    pipe = TestBed.runInInjectionContext(() => new MoneyPipe());
  });

  it('formats cents as MXN under the Spanish locale', () => {
    language.use('es');
    expect(pipe.transform(1250000)).toBe('$12,500.00 MXN');
  });

  it('formats cents as MXN under the English locale', () => {
    language.use('en');
    expect(pipe.transform(1250000)).toBe('$12,500.00 MXN');
  });

  it('returns an empty string for null or undefined', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
  });

  it('is registered as an impure pipe so it re-renders on locale change', () => {
    const meta = (MoneyPipe as unknown as { ɵpipe: { pure: boolean } }).ɵpipe;
    expect(meta.pure).toBe(false);
  });
});
