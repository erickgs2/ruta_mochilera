import type { EnvironmentProviders, Provider } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';

/**
 * Registers `@ngx-translate/core` for the admin app: Spanish is both the
 * initial language and the fallback (see `LanguageService` for how the
 * active language is chosen and persisted), and translations are fetched
 * from `/assets/i18n/<lang>.json` -- see `es.json` / `en.json` in this
 * library, published there by `apps/admin`'s build (extra `assets` entry in
 * `apps/admin/project.json`).
 *
 * `@ngx-translate/core` v18 replaced the old `defaultLanguage`/object-shaped
 * `loader` config (as originally sketched in the Task 16 brief, which
 * targeted an older version of the library) with `lang`/`fallbackLang` and a
 * `loader` slot that takes a ready-made provider list, which is what
 * `provideTranslateHttpLoader` returns.
 */
export function provideI18n(): (Provider | EnvironmentProviders)[] {
  return provideTranslateService({
    lang: 'es',
    fallbackLang: 'es',
    loader: provideTranslateHttpLoader({ prefix: '/assets/i18n/', suffix: '.json' }),
  });
}
