export const environment = {
  // Relative, not absolute: the dev server (apps/client/proxy.conf.json)
  // proxies /api/** to `pnpm nx serve api` (localhost:3000) same-origin, so
  // the browser never makes a cross-origin request and there is no CORS
  // configuration to maintain on the API for local development -- the same
  // setup as `apps/admin`.
  apiBaseUrl: '',
  // Stripe's publishable key. Empty in every committed file on purpose: the
  // real key is injected per build and never committed. With no key the
  // payment screen shows "payments unavailable" instead of loading Stripe.
  stripePublishableKey: '',
};
