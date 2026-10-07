import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { LanguageService } from '@rm/i18n';
import { MoneyPipe } from './money.pipe';

describe('MoneyPipe', () => {
  let pipe: MoneyPipe;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    TestBed.inject(LanguageService).use('es');
    pipe = TestBed.runInInjectionContext(() => new MoneyPipe());
  });

  it('formats MXN cents for display', () => {
    expect(pipe.transform(850_000)).toBe('$8,500.00 MXN');
  });

  it('returns an empty string for null or undefined', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
  });
});
