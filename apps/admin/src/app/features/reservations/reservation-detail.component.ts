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
import { AdminPaymentsApi, AdminReservationsApi, CustomersApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { AuthService, HasPermissionDirective } from '@rm/auth-web';
import { CalendarDatePipe, DateTimePipe } from '@rm/i18n';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyInputComponent, MoneyPipe, PageHeaderComponent, saveFile } from '@rm/ui';
import type { Observable } from 'rxjs';

type StaffReservationDetail = components['schemas']['StaffReservationDetail'];
type Payment = components['schemas']['Payment'];

const PAYMENT_COLUMNS = ['recordedAt', 'amount', 'method', 'status', 'receipt'] as const;

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
    DateTimePipe,
    CalendarDatePipe,
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
    MoneyInputComponent,
    MoneyPipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe, MoneyPipe],
  templateUrl: './reservation-detail.component.html',
  styleUrl: './reservation-detail.component.scss',
})
export class ReservationDetailComponent implements OnInit {
  private readonly reservationsApi = inject(AdminReservationsApi);
  private readonly paymentsApi = inject(AdminPaymentsApi);
  private readonly customersApi = inject(CustomersApi);
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
  readonly canRegisterPayment = this.auth.hasPermission('payment.register');
  readonly canApplyCredit = this.auth.hasPermission('payment.credit.apply');

  /** Phase 2B: cash at the counter and credit applied, in cents. */
  readonly cashAmount = new FormControl(0, { nonNullable: true });
  readonly creditAmount = new FormControl(0, { nonNullable: true });
  readonly paying = signal(false);
  /** The customer's available credit, read only for someone who may see it (`payment.view`). */
  readonly customerCredit = signal<number | null>(null);

  readonly reservation = signal<StaffReservationDetail | null>(null);
  readonly payments = signal<Payment[]>([]);
  readonly loadError = signal<unknown>(null);
  readonly cancelling = signal(false);

  readonly reason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(REASON_MAX_LENGTH)],
  });

  readonly declineReason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(REASON_MAX_LENGTH)],
  });
  readonly declining = signal(false);

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

  /**
   * Closes the customer's request without cancelling: the reservation stays as
   * it is and the customer is told why (`CANCELLATION_DECLINED`). Confirmed
   * first, like cancelling, because the customer is notified at once.
   */
  decline(): void {
    const reservation = this.reservation();
    const reason = this.declineReason.value.trim();
    if (!reservation || !reason) {
      this.declineReason.markAsTouched();
      return;
    }

    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('adminReservations.declineTitle', { code: reservation.code }),
        message: this.translate.instant('adminReservations.declineMessage'),
        confirmKey: 'adminReservations.declineConfirm',
        cancelKey: 'adminReservations.cancelBack',
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.declining.set(true);
      this.reservationsApi.declineCancellation(reservation.id, reason).subscribe({
        next: (updated) => {
          this.declining.set(false);
          this.reservation.set(updated);
          this.declineReason.reset();
          this.snackBar.open(this.translate.instant('adminReservations.declined'), undefined, { duration: 4000 });
        },
        error: (error: unknown) => {
          this.declining.set(false);
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
          this.load();
        },
      });
    });
  }

  /**
   * Cash at the counter (Phase 2B, §5.3): an amount above zero and no more
   * than the balance, confirmed in words, then the receipt goes out.
   */
  registerCash(): void {
    const reservation = this.reservation();
    const amountCents = this.cashAmount.value;
    if (!reservation || amountCents <= 0 || amountCents > reservation.balanceCents) {
      this.cashAmount.markAsTouched();
      return;
    }
    this.confirmThen(
      'adminReservations.cashTitle',
      this.translate.instant('adminReservations.cashMessage', { amount: this.money.transform(amountCents), code: reservation.code }),
      () => this.reservationsApi.registerCash(reservation.id, amountCents),
      'adminReservations.cashDone',
      () => this.cashAmount.reset()
    );
  }

  /** Pays part of the reservation with the customer's credit (Phase 2B, §5.5). */
  applyCredit(): void {
    const reservation = this.reservation();
    const amountCents = this.creditAmount.value;
    const credit = this.customerCredit();
    if (!reservation || amountCents <= 0 || amountCents > reservation.balanceCents || (credit !== null && amountCents > credit)) {
      this.creditAmount.markAsTouched();
      return;
    }
    this.confirmThen(
      'adminReservations.creditTitle',
      this.translate.instant('adminReservations.creditMessage', { amount: this.money.transform(amountCents), code: reservation.code }),
      () => this.reservationsApi.applyCredit(reservation.id, amountCents),
      'adminReservations.creditDone',
      () => this.creditAmount.reset()
    );
  }

  downloadReceipt(payment: Payment): void {
    if (!payment.receiptNumber) return;
    const fileName = `${payment.receiptNumber}.pdf`;
    this.paymentsApi.receipt(payment.id).subscribe({
      next: (blob) => saveFile(blob, fileName),
      error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
    });
  }

  resendReceipt(payment: Payment): void {
    this.paymentsApi.resendReceipt(payment.id).subscribe({
      next: () => this.snackBar.open(this.translate.instant('adminReservations.resent'), undefined, { duration: 4000 }),
      error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
    });
  }

  private confirmThen(
    titleKey: string,
    message: string,
    request: () => Observable<Payment>,
    doneKey: string,
    reset: () => void
  ): void {
    this.dialog
      .open(ConfirmDialogComponent, {
        data: { title: this.translate.instant(titleKey), message, confirmKey: 'adminCustomers.credit.confirm', cancelKey: 'adminReservations.cancelBack' },
      })
      .afterClosed()
      .subscribe((confirmed: boolean) => {
        if (!confirmed) return;
        this.paying.set(true);
        request().subscribe({
          next: (payment) => {
            this.paying.set(false);
            reset();
            this.snackBar.open(this.translate.instant(doneKey, { receipt: payment.receiptNumber ?? '—' }), undefined, {
              duration: 5000,
            });
            this.load();
          },
          error: (error: unknown) => {
            this.paying.set(false);
            this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
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
        this.loadCredit(reservation.customerId);
      },
      error: (error: unknown) => this.loadError.set(error),
    });
    this.loadPayments();
  }

  private loadCredit(customerId: string): void {
    if (!this.canApplyCredit || !this.canViewPayments) return;
    this.customersApi.credit(customerId).subscribe({
      next: (credit) => this.customerCredit.set(credit.balanceCents),
      error: () => this.customerCredit.set(null),
    });
  }

  private loadPayments(): void {
    if (!this.canViewPayments) return;
    this.reservationsApi.payments(this.reservationId).subscribe({
      next: (payments) => this.payments.set(payments),
      error: () => this.payments.set([]),
    });
  }
}
