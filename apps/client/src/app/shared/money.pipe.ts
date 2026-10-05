import { inject, Pipe, type PipeTransform } from '@angular/core';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';

/**
 * Formats MXN cents for display, e.g. "$8,500.00 MXN". Same behaviour as
 * `MoneyPipe` in `@rm/ui`, duplicated for the same reason as
 * `ErrorCodePipe` (see its doc comment): this app does not consume `@rm/ui`.
 * Impure because the locale is a signal read inside `transform()`.
 */
@Pipe({ name: 'rmMoney', standalone: true, pure: false })
export class MoneyPipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(cents: number | null | undefined): string {
    if (cents === null || cents === undefined) return '';
    return formatMoney(cents, this.language.current());
  }
}
