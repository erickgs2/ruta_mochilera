import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { ReservationsApi, type components } from '@rm/api-client';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';
import { CardFormComponent } from './card-form.component';
import { VoucherComponent } from './voucher.component';

type ReservationDetail = components['schemas']['ReservationDetail'];
type CreatedPaymentIntent = components['schemas']['CreatedPaymentIntent'];
type PaymentIntentKind = components['schemas']['CreatePaymentIntentRequest']['intent'];
type PaymentMethod = 'CARD' | 'OXXO';

/**
 * Chooses what to pay towards and how, then starts the payment.
 *
 * **The amount never travels as user input.** The request is an intent
 * (`FULL` or `DEPOSIT`) and a method; the API decides the cents from the
 * reservation's own balance and echoes them back. The amount shown before
 * submitting is a field the API already sent (`balanceCents` or
 * `minimumDepositCents`), never one computed here.
 *
 * The deposit option exists only while the reservation is `HELD`: once the
 * deposit is covered the reservation turns `ACTIVE` and there is no deposit
 * left to pay.
 */
@Component({
  selector: 'rm-payment-method',
  imports: [FormsModule, TranslatePipe, ErrorCodePipe, MoneyPipe, CardFormComponent, VoucherComponent],
  templateUrl: './payment-method.component.html',
  styleUrl: './payments.scss',
})
export class PaymentMethodComponent {
  private readonly api = inject(ReservationsApi);

  readonly reservation = input.required<ReservationDetail>();
  /** Stripe accepted the card; the parent waits for the webhook. */
  readonly cardConfirmed = output<void>();

  readonly intent = signal<PaymentIntentKind>('FULL');
  readonly method = signal<PaymentMethod>('CARD');
  readonly loading = signal(false);
  readonly error = signal<unknown>(null);
  readonly created = signal<CreatedPaymentIntent | null>(null);

  readonly canPayDeposit = computed(() => this.reservation().status === 'HELD');
  readonly amountToShow = computed(() =>
    this.intent() === 'DEPOSIT' && this.canPayDeposit()
      ? this.reservation().minimumDepositCents
      : this.reservation().balanceCents
  );

  async submit(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    const intent = this.canPayDeposit() ? this.intent() : 'FULL';

    try {
      this.created.set(
        await firstValueFrom(this.api.createPaymentIntent(this.reservation().id, { intent, method: this.method() }))
      );
    } catch (error) {
      this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Back to choosing, e.g. to try another method. */
  reset(): void {
    this.created.set(null);
    this.error.set(null);
  }
}
