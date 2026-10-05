import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { ErrorCodePipe } from '../../shared/error-code.pipe';

/**
 * The `/register` screen. Mirrors the field set `registerRequestSchema`
 * (`@rm/contracts`) requires: `email`, `password`, `fullName`, `phone`,
 * `birthDate`, `acceptTerms`.
 *
 * The backend always answers 200 whether or not the email was already
 * registered (see `registerCustomer`'s doc comment in `@rm/domain-identity`)
 * and sends a verification email either way, so this screen never learns
 * which branch happened -- it just confirms submission and sends the
 * visitor to `/login`. It does NOT log the visitor in automatically: the
 * backend's `login` does not actually require a verified email today (see
 * `auth-service.ts`), but this screen does not rely on that -- it always
 * routes through the real login form.
 */
@Component({
  selector: 'rm-register',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss',
})
export class RegisterComponent {
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  readonly loading = signal(false);
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(10)]],
    fullName: ['', [Validators.required, Validators.minLength(3)]],
    phone: ['', [Validators.required, Validators.minLength(7)]],
    birthDate: ['', Validators.required],
    acceptTerms: [false, Validators.requiredTrue],
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    // `acceptTerms` itself is not destructured: `Validators.requiredTrue`
    // above already guarantees it is `true` by the time the form is valid,
    // and `registerRequestSchema` wants that as the literal `true`, not the
    // boolean the form control holds.
    const { email, password, fullName, phone, birthDate } = this.form.getRawValue();

    try {
      await firstValueFrom(this.api.register({ email, password, fullName, phone, birthDate, acceptTerms: true }));
      await this.router.navigate(['/login']);
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
