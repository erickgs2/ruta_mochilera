import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { LanguageService } from '@rm/i18n';
import { formatMoney } from '@rm/shared-utils';
import { STRIPE_LOADER, STRIPE_PUBLISHABLE_KEY } from '../../core/stripe/stripe-loader';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { reservation, type ReservationDetail } from '../../testing/reservation-fixtures';
import { PaymentMethodComponent } from './payment-method.component';

function setup(value: ReservationDetail = reservation(), { publishableKey = 'pk_test_123' } = {}) {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [PaymentMethodComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: STRIPE_PUBLISHABLE_KEY, useValue: publishableKey },
      // Stripe.js is never loaded in these tests: a card form that does get
      // rendered degrades to "unavailable" instead of fetching the script.
      { provide: STRIPE_LOADER, useValue: () => Promise.reject(new Error('Stripe.js is not loaded in tests')) },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'payments.voucher.notice',
      'payments.unavailable',
      'errors.VALIDATION_FAILED',
      'errors.UNKNOWN',
    ])
  );
  TestBed.inject(LanguageService).use('es');
  const fixture = TestBed.createComponent(PaymentMethodComponent);
  fixture.componentRef.setInput('reservation', value);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http: TestBed.inject(HttpTestingController) };
}

function amountShown(element: HTMLElement): string {
  return element.querySelector('.payment-amount')?.textContent ?? '';
}

describe('PaymentMethodComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('switching between paying everything and paying the deposit changes the amount shown and only the intent sent', async () => {
    const { fixture, component, http } = setup(reservation({ balanceCents: 500_000, minimumDepositCents: 100_000 }));

    component.intent.set('FULL');
    fixture.detectChanges();
    expect(amountShown(fixture.nativeElement)).toContain(formatMoney(500_000, 'es'));
    const full = component.submit();
    const fullRequest = http.expectOne('/api/v1/reservations/res-1/payment-intents');
    fullRequest.flush({ providerIntentId: 'pi_1', clientSecret: 's_1', amountCents: 500_000, method: 'CARD' }, { status: 201, statusText: 'Created' });
    await full;

    component.reset();
    component.intent.set('DEPOSIT');
    fixture.detectChanges();
    expect(amountShown(fixture.nativeElement)).toContain(formatMoney(100_000, 'es'));
    const deposit = component.submit();
    const depositRequest = http.expectOne('/api/v1/reservations/res-1/payment-intents');
    depositRequest.flush({ providerIntentId: 'pi_2', clientSecret: 's_2', amountCents: 100_000, method: 'CARD' }, { status: 201, statusText: 'Created' });
    await deposit;

    expect(fullRequest.request.body).toEqual({ intent: 'FULL', method: 'CARD' });
    expect(depositRequest.request.body).toEqual({ intent: 'DEPOSIT', method: 'CARD' });
  });

  it('never sends an amount: the body is exactly an intent and a method', async () => {
    const { component, http } = setup();
    component.intent.set('DEPOSIT');
    component.method.set('OXXO');

    const submitted = component.submit();
    const request = http.expectOne('/api/v1/reservations/res-1/payment-intents');
    request.flush(
      { providerIntentId: 'pi_1', clientSecret: 's_1', amountCents: 100_000, method: 'OXXO', voucherUrl: 'https://v.test/1', voucherExpiresAt: '2028-01-01T00:00:00.000Z' },
      { status: 201, statusText: 'Created' }
    );
    await submitted;

    expect(Object.keys(request.request.body).sort()).toEqual(['intent', 'method']);
  });

  it('offers no deposit option once the reservation is ACTIVE', () => {
    const { fixture } = setup(reservation({ status: 'ACTIVE', holdExpiresAt: null, paidCents: 100_000, balanceCents: 400_000 }));

    expect(fixture.nativeElement.querySelector('input[value="DEPOSIT"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('input[value="FULL"]')).not.toBeNull();
  });

  it('choosing OXXO shows the voucher with its deadline and the balance unchanged, with the credited-on-payment notice', async () => {
    const { fixture, component, http } = setup(reservation({ balanceCents: 500_000 }));
    component.method.set('OXXO');

    const submitted = component.submit();
    http
      .expectOne('/api/v1/reservations/res-1/payment-intents')
      .flush(
        { providerIntentId: 'pi_1', clientSecret: 's_1', amountCents: 500_000, method: 'OXXO', voucherUrl: 'https://fake-oxxo.test/vouchers/pi_1', voucherExpiresAt: '2028-01-15T18:00:00.000Z' },
        { status: 201, statusText: 'Created' }
      );
    await submitted;
    fixture.detectChanges();

    const voucher: HTMLElement = fixture.nativeElement.querySelector('rm-voucher');
    expect(voucher).not.toBeNull();
    expect(voucher.querySelector('a[href="https://fake-oxxo.test/vouchers/pi_1"]')).not.toBeNull();
    expect(voucher.querySelector('.voucher-deadline')?.textContent?.trim()).not.toBe('');
    expect(voucher.querySelector('.voucher-balance')?.textContent).toContain(formatMoney(500_000, 'es'));
    expect(voucher.textContent).toContain(shown('payments.voucher.notice'));
  });

  it('shows a translated error, not the raw code, and leaves the form usable', async () => {
    const { fixture, component, http } = setup();
    component.method.set('OXXO');

    const submitted = component.submit();
    http
      .expectOne('/api/v1/reservations/res-1/payment-intents')
      .flush({ code: 'VALIDATION_FAILED', title: 'x' }, { status: 422, statusText: 'Unprocessable Entity' });
    await submitted;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('errors.VALIDATION_FAILED'));
    expect(component.loading()).toBe(false);
    expect(fixture.nativeElement.querySelector('rm-voucher')).toBeNull();
  });

  describe('in a build with no Stripe publishable key', () => {
    it('shows card payments as unavailable at once and never creates an intent for them', async () => {
      const { fixture, component } = setup(reservation(), { publishableKey: '' });
      component.intent.set('DEPOSIT');
      component.method.set('CARD');
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain(shown('payments.unavailable'));
      expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(true);

      await component.submit();

      // `verify()` in afterEach also fails on any request left unhandled.
      TestBed.inject(HttpTestingController).expectNone('/api/v1/reservations/res-1/payment-intents');
      expect(component.created()).toBeNull();
    });

    it('still lets the customer pay at OXXO', async () => {
      const { fixture, component, http } = setup(reservation(), { publishableKey: '' });
      component.method.set('OXXO');
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).not.toContain(shown('payments.unavailable'));
      expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(false);

      const submitted = component.submit();
      http
        .expectOne('/api/v1/reservations/res-1/payment-intents')
        .flush(
          { providerIntentId: 'pi_1', clientSecret: 's_1', amountCents: 500_000, method: 'OXXO', voucherUrl: 'https://v.test/1', voucherExpiresAt: '2028-01-01T00:00:00.000Z' },
          { status: 201, statusText: 'Created' }
        );
      await submitted;
      expect(component.created()?.method).toBe('OXXO');
    });
  });
});
