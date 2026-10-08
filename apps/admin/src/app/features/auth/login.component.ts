import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService, parseReturnUrl, RETURN_URL_PARAM } from '@rm/auth-web';
import { ErrorCodePipe } from '@rm/ui';

/** Where a sign-in must never send someone: the sign-in screen itself and the dead end. */
const NOT_A_DESTINATION = /^\/(login|forbidden)(?=$|[/?#])/;

/**
 * The `/login` screen: email + password, guarded routes redirect here when
 * unauthenticated. `?returnUrl=` (a same-app path, validated by
 * `parseReturnUrl`) is where a successful sign-in goes; if the user may not
 * open it, or there is none, the root redirect picks the first section they
 * are allowed into (`landingRedirect`).
 */
@Component({
  selector: 'rm-login',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    TranslatePipe,
    ErrorCodePipe,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  private readonly returnUrl = parseReturnUrl(inject(ActivatedRoute).snapshot.queryParamMap.get(RETURN_URL_PARAM));

  readonly loading = signal(false);
  readonly error = signal<unknown>(null);

  readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.loading()) return;

    this.loading.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();

    try {
      await this.auth.login(email, password);
      await this.goToDestination();
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }

  private async goToDestination(): Promise<void> {
    if (this.returnUrl && !NOT_A_DESTINATION.test(this.returnUrl)) {
      await this.router.navigateByUrl(this.returnUrl);
      // The route's own permission guard sends someone without access to
      // `/forbidden`; they should land on a section they can use instead.
      if (!NOT_A_DESTINATION.test(this.router.url)) return;
    }
    await this.router.navigate(['/']);
  }
}
