import { HttpErrorResponse } from '@angular/common/http';
import { inject, Pipe, type PipeTransform } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/**
 * Turns a backend error code into a message in the user's language, the
 * same way `ErrorCodePipe` in `@rm/ui` does for the admin panel -- see that
 * pipe's doc comment for why the backend only ever sends a stable code.
 *
 * Duplicated here on purpose rather than imported: this app does not
 * consume `@rm/ui` at all -- the admin panel is data-dense and this app is
 * mobile-first, and a single pipe this small is not worth promoting the
 * admin panel's component library into a shared dependency just to reuse it.
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
