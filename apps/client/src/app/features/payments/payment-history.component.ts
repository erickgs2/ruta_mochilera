import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { PaymentsApi, ReservationsApi, type components } from '@rm/api-client';
import { CalendarDatePipe } from '@rm/i18n';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';

type ReservationDetail = components['schemas']['ReservationDetail'];
type Payment = components['schemas']['Payment'];

/**
 * `/reservations/:id/payments`, behind the session guard: every payment of
 * one reservation, plus what is still owed and by when.
 *
 * "Paid" and "balance" are the server's own `paidCents` / `balanceCents`;
 * nothing is summed here. A `PENDING` payment -- an OXXO voucher not yet
 * paid at the store, or a card form that was opened and never confirmed --
 * is listed but marked apart, and the server never counts it as paid.
 */
@Component({
  selector: 'rm-payment-history',
  imports: [DatePipe, RouterLink, TranslatePipe, ErrorCodePipe, MoneyPipe, CalendarDatePipe],
  templateUrl: './payment-history.component.html',
  styleUrl: './payments.scss',
})
export class PaymentHistoryComponent {
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  readonly reservation = signal<ReservationDetail | null>(null);
  private readonly allPayments = signal<Payment[]>([]);
  readonly error = signal<unknown>(null);

  /** `GET /payments` covers every reservation of the customer; this screen is about one. */
  readonly payments = computed(() => this.allPayments().filter((payment) => payment.reservationId === this.id));

  constructor() {
    forkJoin({
      reservation: inject(ReservationsApi).get(this.id),
      payments: inject(PaymentsApi).list(),
    }).subscribe({
      next: ({ reservation, payments }) => {
        this.reservation.set(reservation);
        this.allPayments.set(payments);
      },
      error: (error: unknown) => this.error.set(error),
    });
  }
}
