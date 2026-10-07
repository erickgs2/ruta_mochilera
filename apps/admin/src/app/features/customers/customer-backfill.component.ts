import { Component, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BackfillApi, TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { CalendarDatePipe } from '@rm/i18n';
import { ErrorCodePipe, MoneyInputComponent } from '@rm/ui';
import { catchError, map, of } from 'rxjs';

type TripSummary = components['schemas']['TripSummary'];

/** A trip a reservation can be captured on: anything but a draft or a cancelled one (spec §5.7). */
const CAPTURABLE = (trip: TripSummary) => trip.status !== 'DRAFT' && trip.status !== 'CANCELLED';

/**
 * Historical capture for this customer (Phase 2B, §5.7, `data.backfill`): a
 * reservation as it happened before the system, with its payments, on any
 * trip but a draft or a cancelled one. Receipts stay silent unless staff
 * tick the box -- unticked by default.
 *
 * Dates travel as calendar dates (`YYYY-MM-DD`): the API stamps noon of the
 * day in the organization's time zone and refuses a date after today there,
 * so the browser's own time zone plays no part.
 */
@Component({
  selector: 'rm-customer-backfill',
  standalone: true,
  imports: [
    CalendarDatePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
    MoneyInputComponent,
  ],
  providers: [ErrorCodePipe],
  templateUrl: './customer-backfill.component.html',
  styleUrl: './customer-backfill.component.scss',
})
export class CustomerBackfillComponent {
  private readonly backfillApi = inject(BackfillApi);
  private readonly formBuilder = inject(FormBuilder);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly router = inject(Router);

  readonly customerId = input.required<string>();

  readonly saving = signal(false);

  readonly trips = toSignal(
    inject(TripsApi)
      .list()
      .pipe(
        map((trips) => trips.filter(CAPTURABLE)),
        catchError(() => of([] as TripSummary[]))
      ),
    { initialValue: [] as TripSummary[] }
  );

  readonly form = this.formBuilder.nonNullable.group({
    tripId: ['', Validators.required],
    createdAt: ['', Validators.required],
    totalPriceCents: [0],
    payments: this.formBuilder.array<ReturnType<CustomerBackfillComponent['paymentGroup']>>([]),
    sendReceipts: [false],
  });

  get payments(): FormArray<ReturnType<CustomerBackfillComponent['paymentGroup']>> {
    return this.form.controls.payments;
  }

  private paymentGroup() {
    return this.formBuilder.nonNullable.group({
      amountCents: [0, Validators.min(1)],
      paidAt: ['', Validators.required],
      method: ['LEGACY' as 'LEGACY' | 'CASH'],
      notes: [''],
    });
  }

  addPayment(): void {
    this.payments.push(this.paymentGroup());
  }

  removePayment(index: number): void {
    this.payments.removeAt(index);
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.saving.set(true);
    this.backfillApi
      .reservation({
        tripId: value.tripId,
        customerId: this.customerId(),
        createdAt: value.createdAt,
        ...(value.totalPriceCents > 0 ? { totalPriceCents: value.totalPriceCents } : {}),
        payments: value.payments.map((payment) => ({
          amountCents: payment.amountCents,
          paidAt: payment.paidAt,
          method: payment.method,
          ...(payment.notes.trim() ? { notes: payment.notes.trim() } : {}),
        })),
        sendReceipts: value.sendReceipts,
      })
      .subscribe({
        next: (reservation) => {
          this.saving.set(false);
          this.snackBar.open(this.translate.instant('backfill.saved', { code: reservation.code }), undefined, { duration: 5000 });
          void this.router.navigate(['/reservations', reservation.id]);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
  }
}
