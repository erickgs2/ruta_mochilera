import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService, parseReturnUrl, RETURN_URL_PARAM } from '@rm/auth-web';
import { ErrorCodePipe } from '../../shared/error-code.pipe';

/**
 * The `/login` screen: email + password, same shape as the admin panel's
 * (see `apps/admin/src/app/features/auth/login.component.ts`) but with
 * plain HTML controls instead of Angular Material -- this app does not
 * consume `@rm/ui`.
 *
 * `?email=` prefills the address -- the invitation screen links here with
 * the account it just activated. `?returnUrl=` (a same-app path, validated by
 * `parseReturnUrl`) is where a successful sign-in goes; without it, the
 * catalogue.
 */
@Component({
  selector: 'rm-login',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './login.component.html',
  styleUrl: './auth.scss',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  private readonly queryParams = inject(ActivatedRoute).snapshot.queryParamMap;

  /** Validated `?returnUrl=`, or `null`; the screens that link onward pass it along. */
  readonly returnUrl = parseReturnUrl(this.queryParams.get(RETURN_URL_PARAM));
  readonly loading = signal(false);
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group({
    email: [this.queryParams.get('email') ?? '', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();

    try {
      await this.auth.login(email, password);
      await this.router.navigateByUrl(this.returnUrl ?? '/');
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
