import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CustomersApi } from '@rm/api-client';
import { ErrorCodePipe, PageHeaderComponent } from '@rm/ui';

/**
 * Registers a customer at the counter (Phase 2B, §5.1): verified email, no
 * password, and -- unless staff untick it -- the invitation to activate
 * their app account. An email that already belongs to a customer is not an
 * error to fix here: the API answers with that customer's id and this screen
 * opens them.
 */
@Component({
  selector: 'rm-customer-form',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe],
  templateUrl: './customer-form.component.html',
  styleUrl: './customer-form.component.scss',
})
export class CustomerFormComponent {
  private readonly customersApi = inject(CustomersApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);

  readonly saving = signal(false);

  readonly form = inject(FormBuilder).nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    phone: ['', [Validators.required, Validators.minLength(7), Validators.maxLength(30)]],
    birthDate: ['', Validators.required],
    locale: ['es' as 'es' | 'en'],
    sendInvitation: [true],
  });

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.customersApi.create(this.form.getRawValue()).subscribe({
      next: (customer) => {
        this.saving.set(false);
        const key =
          this.form.controls.sendInvitation.value && !customer.invitationSent
            ? 'adminCustomers.form.createdNoInvite'
            : 'adminCustomers.form.created';
        this.snackBar.open(this.translate.instant(key), undefined, { duration: 5000 });
        void this.router.navigate(['..', customer.id], { relativeTo: this.route });
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const existingId =
          error instanceof HttpErrorResponse && error.error?.code === 'CUSTOMER_ALREADY_EXISTS'
            ? (error.error?.details?.customerId as string | undefined)
            : undefined;
        if (existingId) {
          this.snackBar.open(this.translate.instant('adminCustomers.form.alreadyExists'), undefined, { duration: 5000 });
          void this.router.navigate(['..', existingId], { relativeTo: this.route });
          return;
        }
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }
}
