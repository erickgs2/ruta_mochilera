import { Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild, type OnInit } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  STRIPE_LOADER,
  STRIPE_PUBLISHABLE_KEY,
  type StripeClient,
  type StripeElements,
} from '../../core/stripe/stripe-loader';

/**
 * Stripe's Payment Element for one Payment Intent. Stripe.js is loaded here,
 * lazily, and nowhere else (see `loadStripe`).
 *
 * `confirmed` means only "Stripe accepted the card details" -- **never**
 * "the payment is done". The truth arrives through the webhook, so the
 * parent shows "processing" and polls the reservation (see
 * `ReservationDetailComponent`). Stripe's own error text is never shown:
 * every failure maps to one translated message.
 */
@Component({
  selector: 'rm-card-form',
  imports: [TranslatePipe],
  template: `
    @switch (status()) {
      @case ('unavailable') {
        <p class="payments-unavailable">{{ 'payments.unavailable' | translate }}</p>
      }
      @default {
        <form (submit)="$event.preventDefault(); submit()">
          @if (status() === 'loading') {
            <p class="payments-status">{{ 'payments.loadingCard' | translate }}</p>
          }
          <div #paymentElement class="card-element"></div>
          @if (failed()) {
            <p class="payments-error">{{ 'payments.cardFailed' | translate }}</p>
          }
          <button type="submit" [disabled]="status() !== 'ready' || submitting()">
            {{ submitting() ? ('payments.submitting' | translate) : ('payments.cardSubmit' | translate) }}
          </button>
        </form>
      }
    }
  `,
  styleUrl: './payments.scss',
})
export class CardFormComponent implements OnInit {
  private readonly loader = inject(STRIPE_LOADER);
  private readonly publishableKey = inject(STRIPE_PUBLISHABLE_KEY);
  private readonly destroyRef = inject(DestroyRef);

  readonly clientSecret = input.required<string>();
  readonly confirmed = output<void>();

  readonly status = signal<'loading' | 'ready' | 'unavailable'>(this.publishableKey ? 'loading' : 'unavailable');
  readonly submitting = signal(false);
  readonly failed = signal(false);

  private readonly host = viewChild<ElementRef<HTMLElement>>('paymentElement');
  private stripe: StripeClient | null = null;
  private elements: StripeElements | null = null;

  async ngOnInit(): Promise<void> {
    if (!this.publishableKey) return;
    try {
      this.stripe = await this.loader(this.publishableKey);
      this.elements = this.stripe.elements({ clientSecret: this.clientSecret() });
      const element = this.elements.create('payment');
      const host = this.host()?.nativeElement;
      if (host) element.mount(host);
      this.destroyRef.onDestroy(() => element.destroy());
      this.status.set('ready');
    } catch {
      this.status.set('unavailable');
    }
  }

  async submit(): Promise<void> {
    if (!this.stripe || !this.elements || this.submitting()) return;
    this.submitting.set(true);
    this.failed.set(false);
    try {
      const result = await this.stripe.confirmPayment({ elements: this.elements, redirect: 'if_required' });
      if (result.error) this.failed.set(true);
      else this.confirmed.emit();
    } catch {
      this.failed.set(true);
    } finally {
      this.submitting.set(false);
    }
  }
}
