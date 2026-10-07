import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * The slice of Stripe.js this app uses -- the Payment Element and
 * `confirmPayment` -- typed by hand rather than through `@stripe/stripe-js`,
 * so the bundle carries no Stripe code at all until the payment screen asks
 * for it.
 */
export interface StripePaymentElement {
  mount(target: HTMLElement): void;
  destroy(): void;
}

export interface StripeElements {
  create(type: 'payment'): StripePaymentElement;
}

export interface StripeConfirmResult {
  /** Present when the card was declined or the form is incomplete. Only `code` is ever read: Stripe's `message` is never shown. */
  error?: { type?: string; code?: string };
}

export interface StripeClient {
  elements(options: { clientSecret: string }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    redirect: 'if_required';
    confirmParams?: { return_url?: string };
  }): Promise<StripeConfirmResult>;
}

export type StripeLoader = (publishableKey: string) => Promise<StripeClient>;

type StripeFactory = (publishableKey: string) => StripeClient;

const STRIPE_JS_URL = 'https://js.stripe.com/v3/';

let stripeFactory: Promise<StripeFactory> | null = null;

/**
 * Injects Stripe.js the first time it is called, and only then: mounting it
 * at start-up would make every app launch pay for a script most sessions
 * never use. Stripe requires loading it from js.stripe.com rather than
 * bundling it. A failed load is forgotten, so the next attempt retries.
 */
export const loadStripe: StripeLoader = async (publishableKey) => {
  stripeFactory ??= new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.onload = () => {
      const factory = (window as unknown as { Stripe?: StripeFactory }).Stripe;
      if (factory) resolve(factory);
      else reject(new Error('Stripe.js loaded without defining window.Stripe'));
    };
    script.onerror = () => reject(new Error('Stripe.js failed to load'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    stripeFactory = null;
    throw error;
  });

  const factory = await stripeFactory;
  return factory(publishableKey);
};

/** Overridable in tests, so no spec ever reaches js.stripe.com. */
export const STRIPE_LOADER = new InjectionToken<StripeLoader>('STRIPE_LOADER', {
  providedIn: 'root',
  factory: () => loadStripe,
});

/** The build's publishable key; empty means payments are unavailable in this build. */
export const STRIPE_PUBLISHABLE_KEY = new InjectionToken<string>('STRIPE_PUBLISHABLE_KEY', {
  providedIn: 'root',
  factory: () => environment.stripePublishableKey,
});
