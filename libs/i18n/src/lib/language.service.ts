import { inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

export type AppLocale = 'es' | 'en';

const STORAGE_KEY = 'rm.locale';

/**
 * Tracks the active UI language as a signal, persists the choice to
 * `localStorage`, keeps `<html lang>` in sync for accessibility/SEO, and
 * drives `@ngx-translate/core`. `use()` is also what a login/profile screen
 * calls to follow the signed-in user's stored `locale` once the session
 * loads (see `AuthService.user().locale`).
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);

  readonly current = signal<AppLocale>(readStoredLocale());

  constructor() {
    this.translate.addLangs(['es', 'en']);
    this.use(this.current());
  }

  use(locale: AppLocale): void {
    this.current.set(locale);
    this.translate.use(locale);
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }
}

function readStoredLocale(): AppLocale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'es' || stored === 'en') return stored;
  // Spanish is the agency's default language.
  return navigator.language.startsWith('en') ? 'en' : 'es';
}
