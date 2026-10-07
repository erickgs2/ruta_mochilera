import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SettingsApi } from '@rm/api-client';
import { ErrorCodePipe, PageHeaderComponent } from '@rm/ui';

/**
 * The agency details receipts print (Phase 2B, §4.6, `settings.manage`).
 * Saving only affects receipts generated afterwards; issued ones keep the
 * details they were drawn with -- the screen says so.
 */
@Component({
  selector: 'rm-organization-settings',
  standalone: true,
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, TranslatePipe, PageHeaderComponent],
  providers: [ErrorCodePipe],
  templateUrl: './organization-settings.component.html',
  styleUrl: './organization-settings.component.scss',
})
export class OrganizationSettingsComponent {
  private readonly settingsApi = inject(SettingsApi);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);

  readonly saving = signal(false);

  readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    address: ['', Validators.maxLength(300)],
    phone: ['', Validators.maxLength(120)],
    website: ['', Validators.maxLength(200)],
  });

  constructor() {
    this.settingsApi.organization().subscribe({ next: (profile) => this.form.setValue(profile) });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.settingsApi.saveOrganization(this.form.getRawValue()).subscribe({
      next: (profile) => {
        this.saving.set(false);
        this.form.setValue(profile);
        this.snackBar.open(this.translate.instant('adminSettings.saved'), undefined, { duration: 4000 });
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }
}
