import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ReservationsApi, type components } from '@rm/api-client';
import { CalendarDatePipe, DateTimePipe } from '@rm/i18n';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';
import { PaymentMethodComponent } from '../payments/payment-method.component';

type ReservationDetail = components['schemas']['ReservationDetail'];

/** How often, and how many times, the screen re-reads the reservation while a card payment is being confirmed. */
export const PROCESSING_POLL_INTERVAL_MS = 3000;
export const PROCESSING_POLL_ATTEMPTS = 10;

/**
 * `/reservations/:id`, behind the session guard: status, the hold's
 * countdown, the amounts the API sent, and the way to pay.
 *
 * The countdown is computed from `holdExpiresAt` on the device's clock and
 * only says when the hold *should* end. Whether it did is the server's call
 * (the expiry job flips it to `EXPIRED`), so a finished countdown asks the
 * customer to refresh rather than declaring the reservation expired.
 *
 * After a card is confirmed the screen does **not** assume the payment went
 * through: it shows "processing" and re-reads the reservation until
 * `paidCents` moves (the webhook landed), giving up after a bounded number
 * of attempts with a "still processing" message.
 */
@Component({
  selector: 'rm-reservation-detail',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    TranslatePipe,
    ErrorCodePipe,
    MoneyPipe,
    CalendarDatePipe,
    DateTimePipe,
    PaymentMethodComponent,
  ],
  templateUrl: './reservation-detail.component.html',
  styleUrl: './reservations.scss',
})
export class ReservationDetailComponent {
  private readonly api = inject(ReservationsApi);
  private readonly route = inject(ActivatedRoute);

  readonly id = this.route.snapshot.paramMap.get('id') ?? '';
  readonly reservation = signal<ReservationDetail | null>(null);
  readonly error = signal<unknown>(null);
  readonly processing = signal<'idle' | 'polling' | 'slow'>(
    this.route.snapshot.queryParamMap.get('processing') ? 'polling' : 'idle'
  );
  private readonly now = signal(Date.now());

  /** Milliseconds left on a HELD reservation's hold; `null` for any other status. */
  readonly holdLeftMs = computed(() => {
    const reservation = this.reservation();
    if (reservation?.status !== 'HELD' || !reservation.holdExpiresAt) return null;
    return Math.max(0, new Date(reservation.holdExpiresAt).getTime() - this.now());
  });

  readonly countdown = computed(() => {
    const left = this.holdLeftMs();
    if (left === null) return '';
    const totalSeconds = Math.floor(left / 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
  });

  readonly canPay = computed(() => {
    const reservation = this.reservation();
    if (!reservation || reservation.balanceCents <= 0 || this.processing() === 'polling') return false;
    if (reservation.status === 'ACTIVE') return true;
    return reservation.status === 'HELD' && (this.holdLeftMs() ?? 0) > 0;
  });

  /**
   * Phase 2B, §5.9: where the customer's cancellation request stands.
   * `none` offers the button; `pending` says it is under review; `declined`
   * shows staff's reason and offers to ask again. Only for a live reservation.
   */
  readonly cancellationState = computed<'none' | 'pending' | 'declined' | null>(() => {
    const reservation = this.reservation();
    if (!reservation || (reservation.status !== 'HELD' && reservation.status !== 'ACTIVE')) return null;
    if (reservation.cancellationDeclinedAt) return 'declined';
    return reservation.cancellationRequestedAt ? 'pending' : 'none';
  });
  /** The request form is a second step, so a stray tap never sends it. */
  readonly cancellationOpen = signal(false);
  readonly cancellationSending = signal(false);
  readonly cancellationSent = signal(false);
  readonly cancellationReason = new FormControl('', { nonNullable: true, validators: Validators.maxLength(500) });

  private paidBefore = 0;
  private attempts = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      this.stopPolling();
    });
    this.load(() => {
      if (this.processing() === 'polling') this.startPolling();
    });
  }

  refresh(): void {
    this.load();
  }

  openCancellation(): void {
    this.cancellationReason.reset();
    this.cancellationSent.set(false);
    this.cancellationOpen.set(true);
  }

  requestCancellation(): void {
    if (this.cancellationSending() || this.cancellationReason.invalid) return;
    this.cancellationSending.set(true);
    const reason = this.cancellationReason.value.trim();
    this.api.requestCancellation(this.id, reason || undefined).subscribe({
      next: () => {
        this.cancellationSending.set(false);
        this.cancellationOpen.set(false);
        this.cancellationSent.set(true);
        this.load();
      },
      error: (error: unknown) => {
        this.cancellationSending.set(false);
        this.error.set(error);
      },
    });
  }

  /** Stripe accepted the card; wait for the webhook to credit it. */
  onCardConfirmed(): void {
    this.processing.set('polling');
    this.startPolling();
  }

  private load(after?: () => void): void {
    this.api.get(this.id).subscribe({
      next: (reservation) => {
        this.reservation.set(reservation);
        this.error.set(null);
        this.now.set(Date.now());
        after?.();
      },
      error: (error: unknown) => this.error.set(error),
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.paidBefore = this.reservation()?.paidCents ?? 0;
    this.attempts = 0;
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    this.pollTimer = setTimeout(() => {
      this.attempts += 1;
      this.api.get(this.id).subscribe({
        next: (reservation) => {
          this.reservation.set(reservation);
          this.now.set(Date.now());
          if (reservation.paidCents > this.paidBefore) this.processing.set('idle');
          else if (this.attempts >= PROCESSING_POLL_ATTEMPTS) this.processing.set('slow');
          else this.scheduleNextPoll();
        },
        error: () => {
          if (this.attempts >= PROCESSING_POLL_ATTEMPTS) this.processing.set('slow');
          else this.scheduleNextPoll();
        },
      });
    }, PROCESSING_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
