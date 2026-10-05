import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { emailAddress, pastIsoDate } from './auth-validators';

/**
 * The `/register` screen. Mirrors the field set `registerRequestSchema`
 * (`@rm/contracts`) requires: `email`, `password`, `fullName`, `phone`,
 * `birthDate`, `acceptTerms`, and validates them before any request -- a
 * malformed email or an impossible or future birth date never reaches the
 * API.
 *
 * The backend always answers 200 whether or not the email was already
 * registered (see `registerCustomer`'s doc comment in `@rm/domain-identity`)
 * and sends a verification code either way, so this screen never learns
 * which branch happened -- it always moves on to `/verify-email` for the
 * address that was typed.
 */
@Component({
  selector: 'rm-register',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './register.component.html',
  styleUrl: './auth.scss',
})
export class RegisterComponent {
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  readonly loading = signal(false);
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, emailAddress]],
    password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(128)]],
    fullName: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(120)]],
    phone: ['', [Validators.required, Validators.minLength(7), Validators.maxLength(30)]],
    birthDate: ['', [Validators.required, pastIsoDate]],
    acceptTerms: [false, Validators.requiredTrue],
  });

  /** True once the field has been touched (or a submit was attempted) and its value is still invalid. */
  showError(field: keyof typeof this.form.controls): boolean {
    const control = this.form.controls[field];
    return control.invalid && control.touched;
  }

  async submit(): Promise<void> {
    if (this.loading()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    // `acceptTerms` itself is not destructured: `Validators.requiredTrue`
    // above already guarantees it is `true` by the time the form is valid,
    // and `registerRequestSchema` wants that as the literal `true`, not the
    // boolean the form control holds.
    const { email, password, fullName, phone, birthDate } = this.form.getRawValue();

    try {
      await firstValueFrom(this.api.register({ email, password, fullName, phone, birthDate, acceptTerms: true }));
      await this.router.navigate(['/verify-email'], { queryParams: { email } });
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
