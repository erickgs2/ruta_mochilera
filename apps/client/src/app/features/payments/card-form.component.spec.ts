import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import {
  STRIPE_LOADER,
  STRIPE_PUBLISHABLE_KEY,
  type StripeClient,
  type StripeLoader,
} from '../../core/stripe/stripe-loader';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { CardFormComponent } from './card-form.component';

function fakeStripe(confirmResult: { error?: { code?: string } } = {}) {
  const mount = jest.fn();
  const confirmPayment = jest.fn().mockResolvedValue(confirmResult);
  const elements = { create: jest.fn().mockReturnValue({ mount, destroy: jest.fn() }) };
  const client: StripeClient = { elements: jest.fn().mockReturnValue(elements), confirmPayment };
  return { client, mount, confirmPayment, elements };
}

async function setup(key: string, loader: StripeLoader) {
  TestBed.configureTestingModule({
    imports: [CardFormComponent],
    providers: [
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: STRIPE_PUBLISHABLE_KEY, useValue: key },
      { provide: STRIPE_LOADER, useValue: loader },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations(['payments.unavailable', 'payments.cardFailed'])
  );
  const fixture = TestBed.createComponent(CardFormComponent);
  fixture.componentRef.setInput('clientSecret', 'pi_1_secret_x');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

describe('CardFormComponent', () => {
  it('shows "payments unavailable" and never loads Stripe when no publishable key is configured', async () => {
    const loader = jest.fn();

    const { fixture } = await setup('', loader);

    expect(fixture.nativeElement.textContent).toContain(shown('payments.unavailable'));
    expect(loader).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('loads Stripe with the configured key and mounts the payment element for this client secret', async () => {
    const stripe = fakeStripe();
    const loader = jest.fn().mockResolvedValue(stripe.client);

    await setup('pk_test_123', loader);

    expect(loader).toHaveBeenCalledWith('pk_test_123');
    expect(stripe.client.elements).toHaveBeenCalledWith({ clientSecret: 'pi_1_secret_x' });
    expect(stripe.mount).toHaveBeenCalled();
  });

  it('emits confirmed after Stripe accepts the card -- it never claims the payment is done', async () => {
    const stripe = fakeStripe();
    const { component } = await setup('pk_test_123', jest.fn().mockResolvedValue(stripe.client));
    const confirmed = jest.fn();
    component.confirmed.subscribe(confirmed);

    await component.submit();

    expect(stripe.confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'if_required' }));
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("shows a translated failure, never Stripe's own text, when the card is declined", async () => {
    const stripe = fakeStripe({ error: { code: 'card_declined' } });
    const { fixture, component } = await setup('pk_test_123', jest.fn().mockResolvedValue(stripe.client));
    const confirmed = jest.fn();
    component.confirmed.subscribe(confirmed);

    await component.submit();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('payments.cardFailed'));
    expect(confirmed).not.toHaveBeenCalled();
    expect(component.submitting()).toBe(false);
  });

  it('shows "payments unavailable" when Stripe.js cannot be loaded', async () => {
    const { fixture } = await setup('pk_test_123', jest.fn().mockRejectedValue(new Error('offline')));

    expect(fixture.nativeElement.textContent).toContain(shown('payments.unavailable'));
  });
});
