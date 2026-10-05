import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { VoucherComponent } from './voucher.component';

describe('VoucherComponent', () => {
  it('links to the voucher, shows its deadline, and the balance unchanged until it is paid', () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [VoucherComponent],
      providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' })],
    });
    TestBed.inject(TranslateService).setTranslation('es', keyedTranslations(['payments.voucher.notice']));
    TestBed.inject(LanguageService).use('es');
    const fixture = TestBed.createComponent(VoucherComponent);
    fixture.componentRef.setInput('voucherUrl', 'https://fake-oxxo.test/vouchers/pi_1');
    fixture.componentRef.setInput('voucherExpiresAt', '2028-01-15T18:00:00.000Z');
    fixture.componentRef.setInput('amountCents', 100_000);
    fixture.componentRef.setInput('balanceCents', 500_000);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const link = element.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://fake-oxxo.test/vouchers/pi_1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(element.querySelector('.voucher-deadline')?.textContent).toContain('2028');
    expect(element.querySelector('.voucher-amount')?.textContent).toContain(formatMoney(100_000, 'es'));
    expect(element.querySelector('.voucher-balance')?.textContent).toContain(formatMoney(500_000, 'es'));
    expect(element.textContent).toContain(shown('payments.voucher.notice'));
  });
});
