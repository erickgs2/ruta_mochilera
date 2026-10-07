import { Component, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AdminReservationsApi, PublicCatalogueApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { CalendarDatePipe } from '@rm/i18n';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyInputComponent, MoneyPipe } from '@rm/ui';
import { catchError, map, of, switchMap } from 'rxjs';

type PublicTripSummary = components['schemas']['PublicTripSummary'];

/**
 * A reservation taken at the counter for this customer (Phase 2B, §5.2):
 * the trip, and either cash taken right now (the default -- it needs
 * `payment.register` as well as `reservation.create`) or a hold without
 * payment. The trips are the published ones from the public catalogue, the
 * same list a customer sees; the API decides seats, deadline and duplicates.
 */
@Component({
  selector: 'rm-counter-reservation',
  standalone: true,
  imports: [
    CalendarDatePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatRadioModule,
    MatSelectModule,
    TranslatePipe,
    MoneyInputComponent,
    MoneyPipe,
  ],
  providers: [ErrorCodePipe, MoneyPipe],
  templateUrl: './counter-reservation.component.html',
  styleUrl: './counter-reservation.component.scss',
})
export class CounterReservationComponent {
  private readonly catalogueApi = inject(PublicCatalogueApi);
  private readonly reservationsApi = inject(AdminReservationsApi);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly money = inject(MoneyPipe);
  private readonly router = inject(Router);

  readonly customerId = input.required<string>();
  readonly customerName = input.required<string>();

  readonly canTakePayment = inject(AuthService).hasPermission('payment.register');
  readonly saving = signal(false);

  readonly trips = toSignal(this.catalogueApi.list().pipe(catchError(() => of([] as PublicTripSummary[]))), {
    initialValue: [] as PublicTripSummary[],
  });

  readonly form = inject(FormBuilder).nonNullable.group({
    tripSlug: ['', Validators.required],
    mode: [(this.canTakePayment ? 'payment' : 'hold') as 'payment' | 'hold'],
    amountCents: [0],
  });

  submit(): void {
    const { tripSlug, mode, amountCents } = this.form.getRawValue();
    const withPayment = mode === 'payment' && this.canTakePayment;
    if (!tripSlug || (withPayment && amountCents <= 0)) {
      this.form.markAllAsTouched();
      return;
    }
    const trip = this.trips().find((candidate) => candidate.slug === tripSlug);
    const params = { trip: trip?.name ?? tripSlug, name: this.customerName(), amount: this.money.transform(amountCents) };

    this.dialog
      .open(ConfirmDialogComponent, {
        data: {
          title: this.translate.instant('adminCustomers.counter.confirmTitle'),
          message: this.translate.instant(
            withPayment ? 'adminCustomers.counter.confirmWithPayment' : 'adminCustomers.counter.confirmHold',
            params
          ),
          confirmKey: 'adminCustomers.counter.create',
          cancelKey: 'adminCustomers.credit.back',
        },
      })
      .afterClosed()
      .subscribe((confirmed: boolean) => {
        if (!confirmed) return;
        this.saving.set(true);
        // The catalogue is keyed by slug; the reservation needs the trip id,
        // which the public detail carries.
        this.catalogueApi
          .get(tripSlug)
          .pipe(
            map((detail) => detail.id),
            switchMap((tripId) =>
              this.reservationsApi.createAtCounter({
                tripId,
                customerId: this.customerId(),
                ...(withPayment ? { initialPaymentCents: amountCents } : {}),
              })
            )
          )
          .subscribe({
            next: (reservation) => {
              this.saving.set(false);
              this.snackBar.open(
                this.translate.instant('adminCustomers.counter.created', { code: reservation.code }),
                undefined,
                { duration: 5000 }
              );
              void this.router.navigate(['/reservations', reservation.id]);
            },
            error: (error: unknown) => {
              this.saving.set(false);
              this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
            },
          });
      });
  }
}
