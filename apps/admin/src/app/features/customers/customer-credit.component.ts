import { Component, effect, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { DateTimePipe } from '@rm/i18n';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CustomersApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyInputComponent, MoneyPipe } from '@rm/ui';
import type { Observable } from 'rxjs';

type CustomerCredit = components['schemas']['CustomerCredit'];

/** Mirrors the API's 500-character limit on a credit movement's reason. */
const REASON_MAX_LENGTH = 500;

/**
 * A customer's account credit (Phase 2B, §5.5): the balance, every movement
 * behind it, and -- for someone holding `payment.credit.apply` -- the two
 * movements staff make by hand: a refund given back outside the system, and
 * an adjustment in either direction. Both need a reason and a confirmation;
 * the API refuses anything that would take the balance below zero.
 */
@Component({
  selector: 'rm-customer-credit',
  standalone: true,
  imports: [
    DateTimePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    TranslatePipe,
    HasPermissionDirective,
    MoneyInputComponent,
    MoneyPipe,
  ],
  providers: [ErrorCodePipe, MoneyPipe],
  templateUrl: './customer-credit.component.html',
  styleUrl: './customer-credit.component.scss',
})
export class CustomerCreditComponent {
  private readonly customersApi = inject(CustomersApi);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly money = inject(MoneyPipe);

  readonly customerId = input.required<string>();
  readonly customerName = input.required<string>();

  readonly columns = ['date', 'kind', 'amount', 'reason'] as const;
  readonly reasonMaxLength = REASON_MAX_LENGTH;
  readonly credit = signal<CustomerCredit | null>(null);
  /** Which hand-made movement is open, if any. */
  readonly mode = signal<'refund' | 'adjust' | null>(null);
  readonly saving = signal(false);

  readonly form = inject(FormBuilder).nonNullable.group({
    amountCents: [0, [Validators.required, Validators.min(1)]],
    direction: ['increase' as 'increase' | 'decrease'],
    reason: ['', [Validators.required, Validators.maxLength(REASON_MAX_LENGTH)]],
  });

  constructor() {
    effect(() => this.load(this.customerId()));
  }

  open(mode: 'refund' | 'adjust'): void {
    this.form.reset();
    this.mode.set(mode);
  }

  close(): void {
    this.mode.set(null);
  }

  submit(): void {
    const mode = this.mode();
    const { amountCents, direction } = this.form.getRawValue();
    const reason = this.form.controls.reason.value.trim();
    if (!mode || this.form.invalid || !reason) {
      this.form.markAllAsTouched();
      return;
    }
    const amount = this.money.transform(amountCents);
    const name = this.customerName();
    const message =
      mode === 'refund'
        ? this.translate.instant('adminCustomers.credit.refundMessage', { amount, name })
        : this.translate.instant(
            direction === 'increase' ? 'adminCustomers.credit.adjustUpMessage' : 'adminCustomers.credit.adjustDownMessage',
            { amount, name }
          );

    this.dialog
      .open(ConfirmDialogComponent, {
        data: {
          title: this.translate.instant(mode === 'refund' ? 'adminCustomers.credit.refundTitle' : 'adminCustomers.credit.adjustTitle'),
          message,
          confirmKey: 'adminCustomers.credit.confirm',
          cancelKey: 'adminCustomers.credit.back',
        },
      })
      .afterClosed()
      .subscribe((confirmed: boolean) => {
        if (!confirmed) return;
        const request: Observable<unknown> =
          mode === 'refund'
            ? this.customersApi.refundCredit(this.customerId(), { amountCents, reason })
            : this.customersApi.adjustCredit(this.customerId(), {
                amountCents: direction === 'increase' ? amountCents : -amountCents,
                reason,
              });
        this.saving.set(true);
        request.subscribe({
          next: () => {
            this.saving.set(false);
            this.mode.set(null);
            this.snackBar.open(this.translate.instant('adminCustomers.credit.saved'), undefined, { duration: 4000 });
            this.load(this.customerId());
          },
          error: (error: unknown) => {
            this.saving.set(false);
            this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
          },
        });
      });
  }

  private load(customerId: string): void {
    this.customersApi.credit(customerId).subscribe({
      next: (credit) => this.credit.set(credit),
      error: () => this.credit.set(null),
    });
  }
}
