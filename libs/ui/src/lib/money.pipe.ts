import { inject, Pipe, type PipeTransform } from '@angular/core';
import { formatMoney } from '@rm/shared-utils';
import { LanguageService } from '@rm/i18n';

/**
 * Formats an amount stored in MXN cents (the workspace never uses `Float` or
 * `Decimal` for money -- see CLAUDE.md) for display, e.g. `1250000 | rmMoney`
 * renders as "$12,500.00 MXN". Marked `pure: false` on purpose: the locale
 * comes from `LanguageService.current`, a signal read inside `transform()`
 * rather than passed as a pipe argument, so a pure pipe would keep the
 * cached result (and the wrong locale) after the user switches language,
 * since Angular's pipe memoization only compares the `cents` argument.
 */
@Pipe({ name: 'rmMoney', standalone: true, pure: false })
export class MoneyPipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(cents: number | null | undefined): string {
    if (cents === null || cents === undefined) return '';
    return formatMoney(cents, this.language.current());
  }
}
