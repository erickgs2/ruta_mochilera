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
  request value. **When the remaining window floors to less than one whole
  day, `createIntent` refuses the request (`VALIDATION_FAILED`) instead of
  clamping it up to Stripe's one-day minimum** -- clamping up would ask
  Stripe to keep the voucher alive for up to a full day after a short hold
  (`hold_ttl_hours` can be well under 24) has already released the seat,
  which is the exact bug a Task 9 review round found in the first version
  of this function. `oxxoExpiresAfterDays` is a pure function needing no
  Stripe account, and it is unit-tested directly in
  `stripe-payment-provider.spec.ts`, across the day-boundary cases --
  unlike the rest of this class, which remains typechecked only.
- **OXXO on an `ACTIVE` reservation** (abono libre spec §5.4). An `ACTIVE`
  reservation has no hold to bound its voucher, so the domain asks for its
  own validity in days (owner decision D3: 3) and sends
  `oxxoDeadlineAfterDays(days)` as `voucherExpiresAt`: the end of the Nth
  Mexico City calendar day, which `oxxoExpiresAfterDays` turns back into
  exactly N. The port's promise does not change -- never later than
  `voucherExpiresAt` -- only who decides that instant (the hold for `HELD`,
  the validity for `ACTIVE`). The round trip is unit-tested; Stripe's own
  reading of `expires_after_days` is not.
- **Per-method limits** (`STRIPE_LIMITS`, `limitsFor`). MXN 10.00 minimum
  for every method and MXN 10,000.00 per OXXO voucher, as Stripe documents
  them -- **to verify against the real account** (spec §13). The domain
  checks them before asking for an intent and tells the traveler which
  method is unavailable; `createIntent` still refuses an amount outside them
  (`VALIDATION_FAILED`, `reason: outside_provider_limits`) as the caller's
  bug. `FakePaymentProvider` uses the same table unless a test overrides a
  method.
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

## Un solo analizador de eventos, dos firmas (Tarea 10)

`verifyWebhook` se partió en dos mitades: comprobar la firma, que es lo
único en que las implementaciones difieren, y leer el cuerpo, que ahora
hacen las dos con el mismo `parseStripeEventBody` sobre la forma real de un
evento de Stripe. `FakePaymentProvider` ya no tiene un formato propio, así
que una prueba que lo usa ejercita el mismo análisis que correría contra
Stripe.

El analizador **nunca rechaza un evento por su tipo**: sólo un cuerpo que no
es JSON, o al que le faltan `id`, `type` o `created`, devuelve error. Un tipo
que no atendemos se entrega igual y lo ignora `handleStripeEvent`, porque
Stripe reintenta ante cualquier respuesta que no sea 2xx.

Una tercera traducción no verificada contra una cuenta real se suma a las
dos de arriba: **la expiración del voucher de OXXO**. Stripe no tiene un
evento propio para eso; llega como un `payment_intent.payment_failed` con
`last_payment_error.code = payment_intent_payment_attempt_expired`
(`OXXO_VOUCHER_EXPIRED_FAILURE_CODE`). De ese código depende que el pago
quede `EXPIRED` en vez de `FAILED`, así que es lo primero que hay que
confirmar en cuanto exista una cuenta de Stripe.
