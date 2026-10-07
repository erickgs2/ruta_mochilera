import { Component, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PaymentsApi, type components } from '@rm/api-client';
import { DateTimePipe } from '@rm/i18n';
import { MoneyPipe } from '../../shared/money.pipe';

type CustomerCredit = components['schemas']['CustomerCredit'];

/**
 * «Mi cuenta» → account credit (Phase 2B, §5.5): the balance and every
 * movement behind it, **read-only**. The agency manages it -- applies it to
 * a reservation or gives it back -- so there is nothing to press here.
 * Hidden entirely while there has never been a movement.
 */
@Component({
  selector: 'rm-account-credit',
  imports: [TranslatePipe, DateTimePipe, MoneyPipe],
  template: `
    @if (credit(); as credit) {
      @if (credit.entries.length > 0) {
        <section class="credit">
          <h2>{{ 'profile.credit.title' | translate }}</h2>
          <p class="credit-balance">
            {{ 'profile.credit.balance' | translate }} <strong>{{ credit.balanceCents | rmMoney }}</strong>
          </p>
          <p class="credit-explanation">{{ 'profile.credit.explanation' | translate }}</p>
          <ul class="credit-entries">
            @for (entry of credit.entries; track entry.id) {
              <li class="credit-entry">
                <span>{{ 'profile.credit.kinds.' + entry.kind | translate }}</span>
                <span class="credit-amount" [class.credit-amount--out]="entry.amountCents < 0">{{ entry.amountCents | rmMoney }}</span>
                <span class="credit-date">{{ entry.createdAt | rmDateTime: 'mediumDate' }}</span>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
  styles: `
    .credit {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 1rem;
      border-radius: var(--rm-radius-card);
      background: var(--rm-surface);
      border: 1px solid var(--rm-line);
    }
    h2 {
      font-size: 1rem;
      margin: 0;
    }
    p {
      margin: 0;
    }
    .credit-balance strong {
      font-size: 1.25rem;
    }
    .credit-explanation,
    .credit-date {
      color: var(--rm-ink-soft);
      font-size: 0.875rem;
    }
    .credit-entries {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .credit-entry {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0 1rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--rm-line);
    }
    .credit-amount {
      font-weight: 600;
      text-align: right;
    }
    .credit-amount--out {
      color: var(--rm-danger);
    }
  `,
})
export class AccountCreditComponent {
  readonly credit = signal<CustomerCredit | null>(null);

  constructor() {
    inject(PaymentsApi)
      .credit()
      .subscribe({ next: (credit) => this.credit.set(credit), error: () => this.credit.set(null) });
  }
}
