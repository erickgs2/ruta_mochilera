export const environment = {
  // Production web builds are served behind the same origin as the API
  // (the way `apps/admin` is -- see its `environment.ts`), so the browser
  // makes same-origin requests and there is no base URL to prefix.
  //
  // This is NOT the value Capacitor uses: a packaged app has no "same
  // origin" with the API at all (see `apps/client/capacitor.config.ts`),
  // so the native build points this at an absolute API URL instead via
  // `environment.capacitor.ts`.
  apiBaseUrl: '',
  // Stripe's publishable key. Empty in every committed file on purpose: the
  // real key is injected per build and never committed. With no key the
  // payment screen shows "payments unavailable" instead of loading Stripe.
  stripePublishableKey: '',
};
