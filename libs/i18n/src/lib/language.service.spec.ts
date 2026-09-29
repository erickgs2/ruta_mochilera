import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from './language.service';

describe('LanguageService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideTranslateService()],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to Spanish when nothing is stored and the browser is not English', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-MX');
    const service = TestBed.inject(LanguageService);
    expect(service.current()).toBe('es');
  });

  it('defaults to English when nothing is stored and the browser is English', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const service = TestBed.inject(LanguageService);
    expect(service.current()).toBe('en');
  });

  it('restores a previously chosen locale from storage', () => {
    localStorage.setItem('rm.locale', 'en');
    const service = TestBed.inject(LanguageService);
    expect(service.current()).toBe('en');
  });

  it('persists the locale and updates the document language on use()', () => {
    const service = TestBed.inject(LanguageService);
    service.use('en');
    expect(service.current()).toBe('en');
    expect(localStorage.getItem('rm.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
