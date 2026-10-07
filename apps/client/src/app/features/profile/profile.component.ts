import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { ProfileApi, type components } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { AccountCreditComponent } from './account-credit.component';
import { ErrorCodePipe } from '../../shared/error-code.pipe';

type CustomerProfile = components['schemas']['CustomerProfile'];

/**
 * `/account`, behind the session guard: the customer's own profile and the
 * way to their reservations, their inbox, and out.
 *
 * Name, phone and photo can change here; **the email cannot** -- changing it
 * would require verifying the new address again, which is not part of this
 * phase. The form has no email control at all, and the API refuses one
 * anyway (`PATCH /me/profile` is strict).
 *
 * Signing out returns to the public catalogue at `/`.
 */
@Component({
  selector: 'rm-profile',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, ErrorCodePipe, AccountCreditComponent],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent {
  private readonly api = inject(ProfileApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  readonly profile = signal<CustomerProfile | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly uploading = signal(false);
  readonly error = signal<unknown>(null);

  // Same limits as registration (`registerRequestSchema`).
  readonly form = this.formBuilder.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(120)]],
    phone: ['', [Validators.required, Validators.minLength(7), Validators.maxLength(30)]],
  });

  constructor() {
    this.api.get().subscribe({
      next: (profile) => this.show(profile),
      error: (error: unknown) => this.error.set(error),
    });
  }

  showError(field: 'fullName' | 'phone'): boolean {
    const control = this.form.controls[field];
    return control.invalid && control.touched;
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    const { fullName, phone } = this.form.getRawValue();
    try {
      this.show(await firstValueFrom(this.api.update({ fullName, phone })));
      this.saved.set(true);
    } catch (error) {
      this.error.set(error);
    } finally {
      this.saving.set(false);
    }
  }

  onPhotoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.uploadPhoto(file);
    input.value = '';
  }

  async uploadPhoto(file: File): Promise<void> {
    this.uploading.set(true);
    this.error.set(null);
    try {
      this.profile.set(await firstValueFrom(this.api.uploadPhoto(file)));
    } catch (error) {
      this.error.set(error);
    } finally {
      this.uploading.set(false);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/']);
  }

  private show(profile: CustomerProfile): void {
    this.profile.set(profile);
    this.form.setValue({ fullName: profile.fullName, phone: profile.phone });
  }
}
