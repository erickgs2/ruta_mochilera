import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AdminReservationsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { AuthService, HasPermissionDirective } from '@rm/auth-web';
import { CalendarDatePipe } from '@rm/i18n';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyPipe, PageHeaderComponent } from '@rm/ui';

type StaffReservationDetail = components['schemas']['StaffReservationDetail'];
type Payment = components['schemas']['Payment'];

const PAYMENT_COLUMNS = ['recordedAt', 'amount', 'method', 'status'] as const;

/** Mirrors the `cancelReservationRequestSchema` limit, so the form refuses what the API would. */
const REASON_MAX_LENGTH = 500;

/**
 * One reservation, for staff (Task 19): who the customer is, where the money
 * stands, the cancellation request with its reason, the payment history, and
 * the cancel action.
 *
 * Cancelling asks for a reason (it is what the customer reads in their
 * notice) and then confirms in words what happens: the seat is released and
 * every cent already paid stays recorded. The action is shown only to
 * someone holding `reservation.cancel` and only while the reservation is
 * `HELD` or `ACTIVE` -- convenience, never security: the API checks the same
 * permission and the same states on every call.
 *
 * The payment history is a separate request, made only when the viewer holds
 * `payment.view`, the permission the API gates it on.
 */
@Component({
  selector: 'rm-reservation-detail',
  standalone: true,
  imports: [
    CalendarDatePipe,
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    TranslatePipe,
    ErrorCodePipe,
    HasPermissionDirective,
    MoneyPipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe, MoneyPipe],
  templateUrl: './reservation-detail.component.html',
  styleUrl: './reservation-detail.component.scss',
})
export class ReservationDetailComponent implements OnInit {
  private readonly reservationsApi = inject(AdminReservationsApi);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly money = inject(MoneyPipe);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** Off `ActivatedRoute.params` reactively, never `.snapshot` -- the route-reuse reason the trip screens document. */
  private reservationId = '';

  readonly paymentColumns = PAYMENT_COLUMNS;
  readonly reasonMaxLength = REASON_MAX_LENGTH;
  readonly canViewPayments = this.auth.hasPermission('payment.view');

  readonly reservation = signal<StaffReservationDetail | null>(null);
  readonly payments = signal<Payment[]>([]);
  readonly loadError = signal<unknown>(null);
  readonly cancelling = signal(false);

  readonly reason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(REASON_MAX_LENGTH)],
  });

  readonly isCancellable = computed(() => {
    const status = this.reservation()?.status;
    return status === 'HELD' || status === 'ACTIVE';
  });

  ngOnInit(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.reservationId = params['reservationId'] as string;
      this.reservation.set(null);
      this.payments.set([]);
      this.load();
    });
  }

  cancel(): void {
    const reservation = this.reservation();
    const reason = this.reason.value.trim();
    if (!reservation || !reason) {
      this.reason.markAsTouched();
      return;
    }

    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('adminReservations.cancelTitle', { code: reservation.code }),
        message: this.translate.instant('adminReservations.cancelMessage', {
          trip: reservation.tripName,
          paid: this.money.transform(reservation.paidCents),
        }),
        confirmKey: 'adminReservations.cancelConfirm',
        cancelKey: 'adminReservations.cancelBack',
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.cancelling.set(true);
      this.reservationsApi.cancel(reservation.id, reason).subscribe({
        next: (updated) => {
          this.cancelling.set(false);
          this.reservation.set(updated);
          this.reason.reset();
          this.snackBar.open(this.translate.instant('adminReservations.cancelled'), undefined, { duration: 4000 });
          this.loadPayments();
        },
        error: (error: unknown) => {
          this.cancelling.set(false);
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
          // The reservation may have changed under us (expired, or someone
          // else cancelled it): show what it is now rather than what it was.
          this.load();
        },
      });
    });
  }

  private load(): void {
    this.reservationsApi.get(this.reservationId).subscribe({
      next: (reservation) => {
        this.loadError.set(null);
        this.reservation.set(reservation);
      },
      error: (error: unknown) => this.loadError.set(error),
    });
    this.loadPayments();
  }

  private loadPayments(): void {
    if (!this.canViewPayments) return;
    this.reservationsApi.payments(this.reservationId).subscribe({
      next: (payments) => this.payments.set(payments),
      error: () => this.payments.set([]),
    });
  }
}
