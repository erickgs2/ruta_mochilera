import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { AuthService, parseReturnUrl, RETURN_URL_PARAM } from '@rm/auth-web';
import { SessionUserRefresher } from '../../core/session-user';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { emailAddress } from './auth-validators';

/**
 * Matches the backend's default `otp.resend_cooldown_seconds`. The API stays
 * the authority: if an administrator raises that setting, a resend inside
 * the longer window comes back as `OTP_RESEND_TOO_SOON` and is shown
 * translated -- this countdown is only a courtesy that saves most of those
 * round trips.
 */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * `/verify-email?email=…`, where `/register` sends the visitor. Takes the
 * six-digit code from the email and lets the visitor ask for another one
 * once the cooldown has passed. The cooldown starts on open only when the
 * navigation says a code was just sent (`/register` passes `state.codeSent`);
 * the reserve screen's "verify your email" invitation sends none, so resend
 * is available at once there. `?returnUrl=` is where the visitor goes next.
 */
@Component({
  selector: 'rm-verify-email',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './verify-email.component.html',
  styleUrl: './auth.scss',
})
export class VerifyEmailComponent {
  private readonly api = inject(AuthApi);
  private readonly formBuilder = inject(FormBuilder);
  private readonly sessionUser = inject(SessionUserRefresher);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly codeJustSent = this.router.currentNavigation()?.extras.state?.['codeSent'] === true;

  /** Validated `?returnUrl=`, or `null`. */
  readonly returnUrl = parseReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM));
  /** `returnUrl` as a tree, because a `routerLink` string would encode its `?query`. */
  readonly returnTree = this.returnUrl === null ? null : this.router.parseUrl(this.returnUrl);
  /** A customer already signed in (verifying from the reserve invitation) has nothing left to sign in to. */
  readonly signedIn = inject(AuthService).isAuthenticated;

  readonly loading = signal(false);
  readonly verified = signal(false);
  readonly resending = signal(false);
  readonly resent = signal(false);
  readonly error = signal<unknown>(null);
  readonly cooldownLeft = signal(0);
  readonly canResend = computed(() => this.cooldownLeft() === 0 && !this.resending());

  readonly form = this.formBuilder.nonNullable.group({
    email: [this.route.snapshot.queryParamMap.get('email') ?? '', [Validators.required, emailAddress]],
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopTimer());
    if (this.codeJustSent) this.startCooldown();
  }

  async submit(): Promise<void> {
    if (this.loading()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.resent.set(false);
    const { email, code } = this.form.getRawValue();

    try {
      await firstValueFrom(this.api.verifyEmail({ email, code }));
      this.verified.set(true);
      this.stopTimer();
      // A customer already signed in on this device (login does not require
      // a verified email) would otherwise keep a cached `emailVerified:
      // false` and still see "verify your email" on the reserve screen.
      // Best effort: the verification itself already succeeded.
      void this.sessionUser.refresh().catch(() => undefined);
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }

  async resend(): Promise<void> {
    const email = this.form.controls.email;
    if (!this.canResend()) return;
    if (email.invalid) {
      email.markAsTouched();
      return;
    }

    this.resending.set(true);
    this.error.set(null);
    this.resent.set(false);

    try {
      await firstValueFrom(this.api.resendCode({ email: email.value }));
      this.resent.set(true);
      this.startCooldown();
    } catch (error) {
      this.error.set(error);
    } finally {
      this.resending.set(false);
    }
  }

  private startCooldown(): void {
    this.stopTimer();
    this.cooldownLeft.set(RESEND_COOLDOWN_SECONDS);
    this.timer = setInterval(() => {
      this.cooldownLeft.update((seconds) => seconds - 1);
      if (this.cooldownLeft() <= 0) this.stopTimer();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
