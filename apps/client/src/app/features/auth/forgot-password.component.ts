import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { emailAddress } from './auth-validators';

/**
 * `/forgot-password`. The backend answers the same way whether or not the
 * email has an account (see `requestPasswordReset` in `@rm/domain-identity`),
 * so this screen shows one neutral confirmation either way and never hints
 * at which case happened.
 */
@Component({
  selector: 'rm-forgot-password',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './forgot-password.component.html',
  styleUrl: './auth.scss',
})
export class ForgotPasswordComponent {
  private readonly api = inject(AuthApi);
  private readonly formBuilder = inject(FormBuilder);

  readonly loading = signal(false);
  readonly sent = signal(false);
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, emailAddress]],
  });

  async submit(): Promise<void> {
    if (this.loading()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      await firstValueFrom(this.api.forgotPassword(this.form.getRawValue()));
      this.sent.set(true);
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
