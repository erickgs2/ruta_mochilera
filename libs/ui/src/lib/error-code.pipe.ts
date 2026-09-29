import { HttpErrorResponse } from '@angular/common/http';
import { inject, Pipe, type PipeTransform } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/**
 * Turns a backend error code into a message in the user's language. The
 * backend never sends human-facing prose (see CLAUDE.md): it returns a
 * stable code such as `TRIP_SOLD_OUT`, and this pipe is the only place an
 * error becomes words, via the `errors.*` keys in `@rm/i18n`'s catalogues.
 *
 * Falls back to `errors.UNKNOWN` for a code with no translation, so a caller
 * that forwards a raw `HttpErrorResponse`, a bare code string, or something
 * unrecognized never renders an untranslated code or an empty string.
 */
@Pipe({ name: 'rmErrorCode', standalone: true, pure: false })
export class ErrorCodePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(error: unknown): string {
    const code =
      error instanceof HttpErrorResponse && typeof error.error?.code === 'string'
        ? error.error.code
        : typeof error === 'string'
          ? error
          : 'UNKNOWN';

    const key = `errors.${code}`;
    const message = this.translate.instant(key);
    return message === key ? this.translate.instant('errors.UNKNOWN') : message;
  }
}
