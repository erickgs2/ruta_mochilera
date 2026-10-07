import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MoneyPipe } from '../../shared/money.pipe';

/**
 * The OXXO voucher after it was issued. The balance is shown **unchanged**:
 * an OXXO payment is credited only when the customer pays at the store and
 * Stripe's webhook confirms it, so showing it as paid now would be a lie.
 * The deadline is an instant (it never outlives the hold), so it follows the
 * viewer's own time zone through `DatePipe`.
 */
@Component({
  selector: 'rm-voucher',
  imports: [DatePipe, TranslatePipe, MoneyPipe],
  template: `
    <section class="voucher">
      <h3>{{ 'payments.voucher.title' | translate }}</h3>
      <p class="voucher-amount">{{ 'payments.voucher.amount' | translate }}: {{ amountCents() | rmMoney }}</p>
      <p class="voucher-deadline">
        {{ 'payments.voucher.expiresAt' | translate }}: {{ voucherExpiresAt() | date: 'medium' }}
      </p>
      <a class="voucher-open" [href]="voucherUrl()" target="_blank" rel="noopener noreferrer">
        {{ 'payments.voucher.open' | translate }}
      </a>
      <p class="voucher-balance">{{ 'payments.voucher.balanceUnchanged' | translate }}: {{ balanceCents() | rmMoney }}</p>
      <p class="voucher-notice">{{ 'payments.voucher.notice' | translate }}</p>
    </section>
  `,
  styleUrl: './payments.scss',
})
export class VoucherComponent {
  readonly voucherUrl = input.required<string>();
  readonly voucherExpiresAt = input.required<string>();
  readonly amountCents = input.required<number>();
  readonly balanceCents = input.required<number>();
}
