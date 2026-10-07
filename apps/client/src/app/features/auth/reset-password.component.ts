import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { ErrorCodePipe } from '../../shared/error-code.pipe';

/** Group-level check: the confirmation field is client-only, the API never sees it. */
function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const { newPassword, confirmPassword } = group.value as { newPassword: string; confirmPassword: string };
  return confirmPassword === '' || newPassword === confirmPassword ? null : { passwordMismatch: true };
}

/**
 * `/reset-password?token=…`, where the password reset email links to (built
 * from `CLIENT_APP_URL` by `requestPasswordReset`). Password rules mirror
 * `resetPasswordRequestSchema` in `@rm/contracts`: 10 to 128 characters.
 *
 * `TOKEN_INVALID` is shown as "this link no longer works" rather than through
 * `ErrorCodePipe`: the global translation of that code talks about an
 * expired session, which is wrong here. Every other code goes through the
 * pipe. On success the server has revoked every session of the account, so
 * this device's session is cleared locally too -- its access token would
 * otherwise keep working until it expires -- and the screen only offers the
 * way back to sign in. `clear()`, not `logout()`: logout would send a
 * refresh token the server has just revoked.
 *
 * The token is read once and then removed from the address bar with
 * `replaceUrl`, so it is neither left on screen nor kept in the history.
 */
@Component({
  selector: 'rm-reset-password',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './reset-password.component.html',
  styleUrl: './auth.scss',
})
export class ResetPasswordComponent {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  readonly loading = signal(false);
  readonly done = signal(false);
  readonly linkInvalid = signal(this.token === '');
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group(
    {
      newPassword: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(128)]],
      confirmPassword: ['', Validators.required],
    },
    { validators: passwordsMatch }
  );

  constructor() {
    if (this.route.snapshot.queryParamMap.has('token')) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { token: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  showPasswordError(): boolean {
    const control = this.form.controls.newPassword;
    return control.invalid && control.touched;
  }

  showMismatchError(): boolean {
    return this.form.hasError('passwordMismatch') && this.form.controls.confirmPassword.touched;
  }

  async submit(): Promise<void> {
    if (this.loading() || this.linkInvalid()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      await firstValueFrom(this.api.resetPassword({ token: this.token, newPassword: this.form.getRawValue().newPassword }));
      this.auth.clear();
      this.done.set(true);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.error?.code === 'TOKEN_INVALID') this.linkInvalid.set(true);
      else this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
