import type { TranslationObject } from '@ngx-translate/core';

/**
 * Test-only. Lets a spec assert that a screen shows the message for a given
 * translation KEY without depending on the wording in `es.json`, so polishing
 * the copy never breaks a test.
 *
 * Each key is registered with the value `«key»`. A raw key cannot be used as
 * its own value: `ErrorCodePipe` treats "the translation equals the key" as
 * "no translation" and falls back to `errors.UNKNOWN`.
 */
export function shown(key: string): string {
  return `«${key}»`;
}

/** Builds the nested translation object `TranslateService.setTranslation()` expects, one `«key»` value per key. */
export function keyedTranslations(keys: readonly string[]): TranslationObject {
  const root: TranslationObject = {};
  for (const key of keys) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as TranslationObject;
    }
    node[parts[parts.length - 1]] = shown(key);
  }
  return root;
}
