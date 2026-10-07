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
import { ErrorCodePipe } from '../../shared/error-code.pipe';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const { password, confirmPassword } = group.value as { password: string; confirmPassword: string };
  return confirmPassword === '' || password === confirmPassword ? null : { passwordMismatch: true };
}

/**
 * `/invitation?token=…`, where a counter customer's invitation links to
 * (Phase 2B, §5.1): they choose a password and accept the terms, and their
 * account is active. Same token handling as `/reset-password` -- read once,
 * removed from the address bar, `TOKEN_INVALID` shown as "this link no
 * longer works" -- and on success the way to sign in, with the account's
 * email the API answered with.
 */
@Component({
  selector: 'rm-invitation',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './invitation.component.html',
  styleUrl: './auth.scss',
})
export class InvitationComponent {
  private readonly api = inject(AuthApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  readonly loading = signal(false);
  readonly activatedEmail = signal<string | null>(null);
  readonly linkInvalid = signal(this.token === '');
  readonly error = signal<unknown>(null);

  readonly form = inject(FormBuilder).nonNullable.group(
    {
      password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(128)]],
      confirmPassword: ['', Validators.required],
      acceptTerms: [false, Validators.requiredTrue],
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

  showError(control: 'password' | 'acceptTerms'): boolean {
    const field = this.form.controls[control];
    return field.invalid && field.touched;
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
      const accepted = await firstValueFrom(
        this.api.acceptInvitation({ token: this.token, password: this.form.getRawValue().password, acceptTerms: true })
      );
      this.activatedEmail.set(accepted.email);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.error?.code === 'TOKEN_INVALID') this.linkInvalid.set(true);
      else this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }
}
