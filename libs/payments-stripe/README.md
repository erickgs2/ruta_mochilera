# payments-stripe

This library was generated with [Nx](https://nx.dev).

## Running unit tests

Run `nx test payments-stripe` to execute the unit tests via [Vitest](https://vitest.dev/).

## No Stripe account in this environment

`StripePaymentProvider` (`src/lib/stripe-payment-provider.ts`) is typechecked
but never executed here: there is no Stripe account or API key available in
development. The shared contract (`src/testing/payment-contract.ts`) runs
only against `FakePaymentProvider`. See the Task 9 report for what that does
and does not prove.

Two specific pieces of `StripePaymentProvider` are best-effort translations
of Stripe's documented API shape, never exercised against a live account:

- **OXXO voucher expiry.** Stripe's own parameter
  (`payment_method_options[oxxo][expires_after_days]`) only accepts a whole
  number of days from intent creation, not an exact timestamp. This adapter
  floors the remaining time towards now (`oxxoExpiresAfterDays`) so the
  voucher can only expire at or before the reservation's `holdExpiresAt`,
  never after -- the direction business rule 5.3 requires -- and then reads
  back whatever Stripe's response actually computed rather than echoing the
  request value.
- **Idempotent cancel.** Stripe itself returns an error when `cancelIntent`
  is called a second time against an already-`canceled` intent, unlike this
  port's contract, which requires a second cancel to be a no-op. The adapter
  absorbs exactly one documented error code
  (`payment_intent_unexpected_state`, mentioning "canceled") into `ok(null)`
  to honour that. This mapping has never run against a real Stripe error
  response.

`createPaymentProvider` selects this class only once both
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set; their absence (in
every environment, not just development/test) is what selects
`FakePaymentProvider` instead.
