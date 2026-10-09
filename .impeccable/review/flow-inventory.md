# Flow inventory — input for the Phase 3 redesign

- **Author:** Echo (read-only analysis, no code changed)
- **Source:** `main` at `57aff1a`, read on 2026-10-07
- **Scope:** `apps/client`, `apps/admin`, `libs/ui`, `libs/i18n/src/assets/es.json`,
  `docs/business-rules/*`, `docs/diagrams/*`, plus the API contract they consume
  (`libs/api-client/src/lib/schema.d.ts`, generated from `@rm/contracts`)
- **Method:** traced every route, template, and API schema by hand. Nothing was
  run in a browser, so this inventory covers structure and states, not
  rendering. Frequency ranking in §2 is inferred from PRODUCT.md and
  `docs/diagrams/counter-sale.md`; there is no usage data.

---

## 0. Top findings

1. **In-app installments don't exist.** The pay form only offers two intents,
   "the whole balance" or "the minimum deposit". The deposit option disappears
   once the reservation is `ACTIVE` (`apps/client/src/app/features/payments/payment-method.component.ts:56,68`).
   The API has no amount or instalment intent either (`CreatePaymentIntentRequest`,
   `schema.d.ts:5405-5410`; `payments.md:329-335`). OXXO always fails on an
   `ACTIVE` reservation because the voucher expiry is the hold expiry and an
   `ACTIVE` reservation has none (`libs/domain/payments/src/lib/payment-intent-service.ts:110-112,143`,
   `libs/payments-stripe/src/lib/stripe-payment-provider.ts:164-165`). It also
   fails when less than a calendar day of hold is left (`:178-181`). SPEI is
   supported by the contract and the provider, but the app doesn't offer it
   (`payment-method.component.ts:15`). **Net effect:** after the deposit, a
   traveler can only pay the **entire remaining balance by card**. Meanwhile the
   copy promises "puedes abonar lo que quieras" (`es.json`, `reserve.suggestedMonthlyHint`),
   and positioning promises monthly payments. A traveler who picks OXXO gets
   «Revisa los datos capturados.» (`es.json:504`). *This needs a product/API
   decision, not just UI.*
2. **The panel can't revive an expired reservation.** Decision 13 lets a cash
   payment or applied credit revive an `EXPIRED` reservation, and the API
   implements it (`apps/api/src/app/api/v1/admin/reservations/[reservationId]/payments/route.ts:21-33`,
   `apply-credit/route.ts:11-23`). The admin detail shows the cash and credit
   sections only when `status` is `HELD` or `ACTIVE`
   (`apps/admin/src/app/features/reservations/reservation-detail.component.ts:114-117`,
   `.html:167`). A shipped Phase 2B behavior is unreachable from the UI. This is
   a functional gap, not only UX.
3. **Login throws away the traveler's intent.** `authGuard` redirects to
   `/login` with no return URL (`libs/auth-web/src/lib/auth.guard.ts:15`), and a
   successful login always goes to `/` (`apps/client/.../auth/login.component.ts:45`).
   A first-time visitor who taps «Reservar» goes through login, register,
   verify-email, then a «Iniciar sesión» link, then login again, and ends on the
   **catalogue**, not on the trip they wanted. The verify screen starts a 60 s
   resend cooldown on open (`verify-email.component.ts:52-55`), even when the
   traveler arrives from the reserve screen's "verify your email" invite, where
   no code was sent. They have to wait a minute to request one.
4. **The app forgets pending OXXO vouchers.** The voucher shows once, inline,
   right after it's created (`voucher.component.ts`). Afterwards the
   reservation detail doesn't mention it and offers the pay form again, which
   invites a second voucher (`payments.md:41-45` accepts the double-pay as a
   consequence). The voucher link is only in the payment history, and its
   deadline isn't shown there (`payment-history.component.html:35-39`).
   `payments.md:32-35` says the app shows the pending payment with its voucher
   and its deadline.
5. **The panel has no fast path for the counter.** Logging in always lands on
   Trips (`apps/admin/src/app/app.routes.ts:14`). There's no global search and
   no search by reservation code (the admin reservations API only filters by
   trip, status, and pending request, `schema.d.ts:2673-2677`). There's no "who
   owes" view and no staff inbox, although `notifyAdmins` writes `INBOX` rows
   for staff (`libs/domain/notifications/src/lib/delivery-service.ts:127-147,197-213`).
   Taking cash is about 6 interactions across 3 screens, ending in a form at the
   bottom of a long page. The minimum deposit, which decides whether the cash
   secures the seat, isn't shown even though the API returns it.

Also worth fixing early: staff without `trip.view` land on `/forbidden`, whose
only button goes back to `/`, which redirects to `/trips`, which is forbidden
again, so they loop (`apps/admin/src/app/layout/forbidden.component.ts:15`).

---

## 1. Traveler journeys

### 1.0 Domain states the UI must be able to express

| Entity | States (source) |
|---|---|
| Reservation | `HELD` (hold running, `holdExpiresAt` set) → `ACTIVE` (deposit covered, no expiry) ; `HELD` → `EXPIRED` (job) ; `HELD`/`ACTIVE` → `CANCELLED` (staff only) ; `EXPIRED` → `HELD`/`ACTIVE` (revival at counter only) — `reservations.md:3-13,298-332` |
| HELD, client-side | hold running · countdown hit zero but the job hasn't run yet (still `HELD`, `reservation-detail.component.ts:59-63`) |
| Cancellation request | none · pending (`cancellationRequestedAt`) · declined (`cancellationDeclinedAt` + reason) — `reservations.md:522-667` |
| Payment | `PENDING` (OXXO voucher, or card intent opened and never confirmed) · `SUCCEEDED` (has receipt folio) · `FAILED` · `EXPIRED` (voucher ran out / intent cancelled) · `REFUNDED` — `schema.d.ts:5483-5503` |
| Payment method | `CARD`, `OXXO`, `SPEI` (online) · `CASH`, `LEGACY`, `CREDIT` (counter/import) |
| Money | total (frozen at creation) · paid (SUCCEEDED only) · balance owed · minimum deposit · suggested monthly (recomputed each read) · payment deadline (calendar date) — `payments.md:11-28,488-535` |
| Credit (saldo a favor) | entries `CANCELLATION`, `PRICE_DECREASE`, `EXPIRATION` (+) · `APPLIED`, `REFUND`, `REVIVAL` (−) · `ADJUSTMENT` (±); read-only for the traveler — `payments.md:598-632` |
| Late money | paid after `EXPIRED` → recorded, **not** credited, human decision (`PAYMENT_AFTER_EXPIRY`) · paid after `CANCELLED` → credited (`PAYMENT_AFTER_CANCELLATION`) — `payments.md:158-214` |
| Notices | inbox + email per event; titles and bodies frozen at send time — `notifications.md` |

### 1.1 Discover — `/` (`features/catalogue/trip-list.component.*`)

Shows the brand bar, a hero (title + tagline), and a grid of cards (cover,
name, dates, price, "Quedan N lugares" or "Agotado", and a «Reservar» link).

States: loading · error (code text only) · empty · list.

Friction:
- The header's only signed-in entry is «Mi cuenta» (`trip-list.component.html:6-10`).
  A traveler with a hold running gets no cue on the home screen. Their hold
  countdown, balance, and next payment aren't visible anywhere until they open
  Mi cuenta, then Mis reservas, then the reservation.
- Card «Reservar» goes to the trip detail (`:50`), not to reserve. That's fine,
  but the label promises an action the tap doesn't perform.
- Card price is the full seat price. The product's core promise ("hold with a
  deposit") can't appear because `PublicTripSummary` has no deposit (§4).
- The error state has no retry action.

### 1.2 Trip detail — `/trips/:slug` (`trip-detail.component.*`)

Shows the name, image gallery, dates, a CTA block (price, seats left,
«Reservar»), then description, itinerary, includes, and excludes as plain
paragraphs.

States: loading · not-found (with a way back) · error · ready (seats > 0 or
sold out).

Friction:
- **The traveler commits blind.** No minimum deposit, payment deadline, hold
  length ("tienes N horas para pagar el anticipo"), or suggested monthly
  payment is shown. `PublicTripDetail` doesn't carry them (`schema.d.ts:5283-5311`),
  although `Trip` has all three (`libs/db/prisma/schema.prisma:319-323`).
- A traveler who already holds a reservation for this trip still sees
  «Reservar». The next step answers `DUPLICATE_RESERVATION` in staff voice:
  «Ya existe una reservación para este viajero en este viaje.» (`es.json:514`).
  There's no link to the existing reservation.
- Sold out is a dead end, with only the header link back to the catalogue.

### 1.3 Sign up / verify — `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/invitation`

Path for a new visitor who tapped «Reservar» on a trip:

`/trips/:slug/reserve` → guard → `/login` (intent lost, `auth.guard.ts:15`) →
«¿No tienes cuenta?» → `/register` (6 fields + terms) → `/verify-email?email=`
(`register.component.ts:69`) → success → «Iniciar sesión» link
(`verify-email.component.html:6-10`) → `/login` → `/` (`login.component.ts:45`)
→ find the trip again → trip detail → «Reservar» → reserve.

That's **8 screens**, and the traveler re-finds the trip by hand.

Friction:
- No return URL anywhere: not in the guard, login, verify, or the invitation
  success link (`invitation.component.html:6-10`).
- Login doesn't require a verified email, but reserving does. So a signed-in,
  unverified traveler hits the verify invite on the reserve screen
  (`reserve.component.html:28-32`). There the 60 s cooldown blocks «Reenviar»
  although no code was just sent (`verify-email.component.ts:52-55`). After
  verifying, the screen offers «Iniciar sesión» to someone who is already signed
  in, instead of "back to your reservation".
- Google and Apple sign-in exist in the API (`apps/api/src/app/api/v1/auth/oauth/google|apple/route.ts`,
  `libs/domain/identity/src/lib/social-login.ts`), but the client has no
  button for either.
- The login heading is a hardcoded, untranslated «Ruta Mochilera»
  (`login.component.html:4`).
- «Acepto los términos y condiciones» has no link to the terms (`register.component.html:47-50`).
- The auth screens have no back link other than the logo.

### 1.4 Reserve (hold) — `/trips/:slug/reserve` (`reserve.component.*`)

Before the hold, the screen shows only «Reservar: {trip}» and the
«Apartar mi lugar» button (`reserve.component.html:9,37-39`). After the hold
it shows a notice with the code, total / minimum deposit / suggested monthly,
the embedded payment form, and «Ver mi reserva».

States: loading trip · trip error · verify invite · idle · submitting · error
(code text) · hold created.

Friction:
- The traveler presses «Apartar mi lugar» **without seeing what it commits
  them to**. The amounts appear only after the hold exists, because the API
  only computes them on the created reservation.
- `reserve.holdCreated` doesn't say until when the seat is held (`es.json:102`).
  There's no countdown on this screen; it lives only on the reservation detail.
- Reloading or coming back to this URL shows «Apartar mi lugar» again, which
  leads to `DUPLICATE_RESERVATION`, a dead end with no link to the existing hold.
- `TRIP_SOLD_OUT`, `PAYMENT_DEADLINE_PASSED`, and `TRIP_NOT_PUBLISHED` render as
  a line of text with no next action.

### 1.5 Pay (card / OXXO / SPEI, «procesando», webhook) — `rm-payment-method`, embedded in reserve and in `/reservations/:id`

Step 1 (`payment-method.component.html:15-55`): «¿Qué quieres pagar?»
(«Todo el saldo» / «El anticipo mínimo», the latter only while `HELD`), then
«¿Cómo quieres pagar?» (Tarjeta / Efectivo en OXXO), then «Pagarás $X», then
«Continuar».

Step 2:
- **Card:** the Stripe Payment Element, then «Pagar». The parent goes to the
  reservation with `?processing=1` and polls 10 × 3 s
  (`reservation-detail.component.ts:14-15,158-182`).
- **OXXO:** the voucher card (amount, «Paga antes de», «Abrir la ficha», «Tu
  saldo sigue en», notice).

States: choosing · creating intent · intent error · card loading / ready /
submitting / failed / unavailable (no key) · processing (polling) · slow
(«Actualiza en unos minutos») · credited (`paidCents` moved) · OXXO voucher
issued.

Friction:
- **The default is the most expensive option.** «Todo el saldo» + card is
  preselected (`payment-method.component.ts:50-51`), while the product's promise
  is "hold with a deposit".
- **OXXO is offered where it can't work:** always on `ACTIVE`, and on `HELD`
  when less than a calendar day of hold is left. The error is «Revisa los datos
  capturados.» (top finding 1).
- SPEI isn't offered. If it were, the client has no screen for transfer
  instructions (CLABE/reference): `CreatedPaymentIntent` carries only
  `clientSecret` plus OXXO voucher fields (`schema.d.ts:5395-5404`).
- `payments.unavailable` tells the traveler to «paga en OXXO» (`es.json:242`).
  That fails too on `ACTIVE`.
- The "slow" state asks the traveler to press «Actualizar» by hand. A card
  declined after confirmation (`PAYMENT_FAILED` via webhook) shows up only in
  the inbox and email, never on the screen that is "processing".
- **The OXXO voucher is shown once.** If the traveler leaves, the reservation
  detail neither shows the pending voucher nor stops offering a new one
  (top finding 4).
- Two different verbs for the same commit: «Continuar» on step 1, «Pagar» in
  the card form.

### 1.6 Installments

There's no installment screen or concept in the UI. The reservation detail
lists «Mensualidad sugerida» and «Fecha límite de pago» as two rows of a
six-row `<dl>` (`reservation-detail.component.html:20-35`).

Friction:
- There's no way to pay the suggested monthly amount, or any amount other than
  deposit or full (top finding 1).
- No "next payment" or "days left until the deadline". The deadline is a bare
  date.
- Warning: the reminder that PRODUCT.md announces for Phase 3A (day 28) will
  point at a payment the app can't take.

### 1.7 Balance / credit — `/reservations`, `/reservations/:id`, `/reservations/:id/payments`, `/account`

Where the money shows up:
- **List rows:** trip, departure, status, «Saldo: $X».
- **Detail:** total, paid, balance, deposit, monthly, deadline.
- **History:** paid, balance, deadline, payment rows.
- **Account:** credit balance + movements. The whole block is hidden while
  there are no movements (`account-credit.component.ts:19-20`).

Friction:
- **«Saldo» means two opposite things.** It's what you owe
  (`reservation.balance`, `es.json:123`) and also, in «Saldo a favor», what the
  agency owes you. The owner's "checking a balance isn't obvious" lands here.
- The list shows «Saldo» on `CANCELLED` and `EXPIRED` rows
  (`reservation-list.component.html:21-23`), where it's meaningless. An expired
  hold whose payments moved to credit still shows the unpaid remainder as
  money owed.
- The reservation detail's title is «Reserva RM-XXXX» with no trip name, dates,
  or image. `ReservationDetail` doesn't carry them (§4).
- Its back link goes to the catalogue, not to «Mis reservas»
  (`reservation-detail.component.html:3`).
- «Apartada» and «Activa» aren't explained. Nothing tells the traveler that
  `ACTIVE` means the seat is secured and no longer expires.
- The hold countdown is `HH:MM:SS`, so a 48 h hold reads «47:59:12», with no
  absolute "until Tuesday 13:00". When it hits zero the UI says «Actualiza
  para ver su estado» (`es.json:120`) and pushes the traveler to refresh.
- Credit movements show only the kind, amount, and date. Each entry's reason
  and reservation link aren't shown (`account-credit.component.ts:28-33`,
  §4), so a traveler can't tell which trip produced the credit. Credit isn't
  mentioned at all in the reservation or pay flow.

### 1.8 Receipt — `/reservations/:id/payments`

Path: reservation detail → «Ver historial de pagos» → the payment row →
«Descargar recibo · RM-2026-000123» (`payment-history.component.html:30-34`).
The receipt is also emailed by the worker.

Friction:
- Two levels deep. It isn't offered at the moment it matters, right after a
  payment is credited.
- A pending OXXO row offers «Abrir la ficha» without its expiry.
- `FAILED` and `EXPIRED` rows have no explanation and no retry action.

### 1.9 Inbox — `/inbox`

The only route in is Mi cuenta → «Avisos» (`profile.component.html:7-10`). The
unread count shows only inside the inbox heading. Items are a title/date
accordion; opening one marks it read.

Events that land here: `HOLD_EXPIRING`, `HOLD_EXPIRED`(`_CREDIT`),
`PAYMENT_CONFIRMED`, `PAYMENT_FAILED`, `VOUCHER_EXPIRED`,
`PAYMENT_AFTER_EXPIRY`, `PAYMENT_AFTER_CANCELLATION`, `RESERVATION_CANCELLED`,
`CANCELLATION_DECLINED`, `PRICE_CHANGED`. Almost all of them call for a next
action ("pay now", "see your reservation", "see your credit").

Friction:
- No item links anywhere. The API doesn't return the delivery's
  `reservation_id` (§4), and `eventType` is returned but unused.
- No unread badge outside the inbox (catalogue header, account).

### 1.10 Cancellation request — inside `/reservations/:id`

States none / pending / declined + reason / just sent are all represented
(`reservation-detail.component.html:50-96`), with a two-step form. This is the
best-covered state machine in the client. The only gap is that it shares one
long page with the money and pay blocks.

### 1.11 Cross-cutting navigation in the client

Every screen builds its own header with a different back target:

| Screen | Back link goes to |
|---|---|
| catalogue | «Mi cuenta» / «Iniciar sesión» |
| trip detail | «Ver todos los viajes» |
| reserve | «Volver al viaje» |
| reservation list | «Mi cuenta» (reuses the `inbox.backToAccount` key) |
| reservation detail | **«Ver todos los viajes»** |
| payment history | «Volver a la reserva» |
| profile | «Ver todos los viajes» |
| inbox | «Mi cuenta» |

There's no persistent navigation and no language switcher. `CustomerProfile`
has no `locale` field (`schema.d.ts:5037-5043`), and there's no UI to change
it, although the product is bilingual and follows each user's preference.

Depth from home for a signed-in traveler: Mis reservas = 2 taps, a
reservation = 3, its receipt = 5.

---

## 2. Staff jobs at the counter, by estimated frequency

Global facts that affect every job:
- Login always lands on `/trips` (`app.routes.ts:14`, `login.component.ts:52`),
  whatever the role.
- There's no global search, dashboard, work queue, or notification surface.
  Staff-facing notices (`CANCELLATION_REQUESTED`, `ORPHAN_PAYMENT`,
  `PAID_CENTS_MISMATCH`) arrive by email only, although inbox rows exist for
  them (§4).
- The sidenav is a flat list of 7 items (§3).
- Errors are swallowed in two lists and look like "no results":
  - Customer search: `catchError → EMPTY_PAGE` (`customer-list.component.ts:78`).
  - Reservation list: the `switchMap` has no `catchError`
    (`reservation-list.component.ts:101-116`). One failed request leaves an
    empty table that never recovers until reload.

| # | Job | Current click path (screens) | Where it slows down |
|---|---|---|---|
| 1 | **Take cash on an existing reservation** | Clientes → type name/phone → open customer → click reservation row → reservation detail → scroll past request, customer, trip, money, and payments sections → «Cobro en efectivo» amount → button → confirm dialog → snackbar (`reservation-detail.component.html:167-208`). 3 screens, ~7 interactions. | No search by reservation code anywhere: a customer holding a receipt or voucher with «RM-…» can't be found by it. The minimum deposit isn't shown (`StaffReservationDetail.minimumDepositCents` unused), so staff can't say «con $X ya queda asegurado». The cash form sits at the bottom of the longest page in the panel. **`EXPIRED`: the form is hidden, so no revival** (top finding 2). The hold expiry is an absolute datetime buried in the Trip card (`:90-92`). |
| 2 | **Walk-in signup + first reservation** | Clientes → search (to avoid a duplicate) → «Nuevo cliente» → form (name, email, phone, birth date, language, invite) → customer detail → scroll to «Reserva en mostrador» → trip dropdown → mode «con pago»/«sólo apartar» → amount → confirm → reservation detail. 4 screens. | The search text isn't carried into the new-customer form. The empty search result has no «Dar de alta» call to action (`customer-list.component.html:14-16`). The trip dropdown comes from the **public** catalogue (`counter-reservation.component.ts:62`): one long line per trip, and no deposit, deadline, or hold length, so staff type an amount without knowing if it activates the seat. It also needs an extra `GET /public/trips/:slug` just to learn the trip id (`:98-110`). A duplicate email silently opens the existing customer, which is good. |
| 3 | **Find a customer / reservation** («¿cuánto debo?» on the phone) | Clientes → search → open. Or Reservas → trip/status filters → scan → eye icon. | Customer results show name/email/phone/account, but **no money and no reservation signal** (`CustomerPage` has none), so every candidate must be opened. The reservation list has **no text search and no pagination** (API: `tripId`, `status`, `cancellationPending` only). Its rows show code/customer/trip/status/balance but not the departure, hold expiry, paid amount, or deadline it already receives. Only the eye icon opens a row; the customer name isn't a link. |
| 4 | **Check who owes** (collections) | No screen. Closest: Reservas → status «Activa» + trip filter → read the balance column. | No sort, no "deadline within N days", no "hold expires today", no totals per trip. Every row already carries `paymentDeadline`, `holdExpiresAt`, `paidCents`, and `totalPriceCents` (`schema.d.ts:5411-5437`). The `reservation.risk.view` permission exists for Phase 3A alerts, but there's no screen behind it. |
| 5 | **Handle a cancellation request** | Email → Reservas → «Sólo con solicitud» toggle (the API already sorts pending first) → detail → decline with reason, or cancel with reason. | Works. The only entry signal is the email and the in-list summary; there's no badge in the nav or toolbar. Decline and cancel live in separate sections of the same long page. |
| 6 | **Create, cost and publish a trip** | Viajes → «Nuevo viaje» → stepper (General, Contenido, [Captura histórica]) → Save → **back to the list** (`trip-form.component.ts:286`) → photo icon → Imágenes → «Volver al viaje» (lands on the edit form) → list → «$» icon → Costeo → (no back link) → list → edit icon → status card → Publicar. 4 screens, with the list as the hub. | Publishing requires an image and a price, and the price comes from costing. The status card lists what's missing (`trip-form.component.html:198-201`) but **doesn't link to the screen that fixes it**, and saving a new trip doesn't continue to images or costing. The costing header is a bare «Costeo» with no trip name and no back link (`trip-costing.component.html:1`). Row actions are 4 icon-only buttons, and the trip name isn't a link (`trips-list.component.html:59-117`). Someone with `trip.view` but not `trip.update` **can't open a trip at all**: `:tripId` is the edit form behind `trip.update` (`trips.routes.ts:22-26`), so counter staff can't read the itinerary and includes to answer a customer. |
| 7 | **Apply credit / refund / adjust** | Apply: reservation detail → «Saldo a favor» section. Refund/adjust: customer detail → credit block. | One concept, two screens. Credit entries don't link to their reservation. `reservations.md:239-240` says the panel shows the credit movement next to the reservation's payments; the reservation detail doesn't. |
| 8 | **Change price on sold seats** | Viajes → price-change icon → preview → notice text → apply. | Coherent. It's reachable only from an icon in the trips list. |
| 9 | **Import CSV** | Importaciones → template → type → file → send-emails → «Validar» → batch → «Aplicar». | Coherent and low frequency. Historical capture is split across 3 places: CSV import, the backfill block at the bottom of the customer detail, and the trip form's backfill step. |
| 10 | **Staff, roles, agency settings** | Sidenav → list → edit. | Low frequency. The menu label «Administradores» (`es.json:311`) names every staff account, not only administrators. |

---

## 3. Navigation IA

### 3.1 Client, current

```
/                       catalogue (public)          header: Mi cuenta | Iniciar sesión
└─ /trips/:slug         trip detail (public)        header: Ver todos los viajes
   └─ /trips/:slug/reserve   hold + pay (guard)     back: Volver al viaje
/account                profile + credit (guard)    back: Ver todos los viajes
├─ /reservations        list (guard)                back: Mi cuenta
│  └─ /reservations/:id         detail + pay + cancel     back: Ver todos los viajes
│     └─ /reservations/:id/payments  history + receipts   back: Volver a la reserva
└─ /inbox               notices (guard)             back: Mi cuenta
/login /register /verify-email /forgot-password /reset-password /invitation   (no return URL)
** → /
```

Reachability:
- Reservations and inbox are reachable **only through Mi cuenta**.
- The hold countdown, pending voucher, next payment, and credit have no
  surface above the reservation detail.
- The profile form (name/phone/photo) shares the account page with credit and
  sign-out, and it's the first thing on that page.

### 3.2 Client, proposal (structure only)

- **Four persistent destinations** for signed-in travelers (tab bar on a
  phone): **Rutas** (catalogue) · **Mis viajes** (reservations) · **Avisos**
  (unread badge) · **Cuenta**. Guests see Rutas + «Entrar».
- **Mis viajes becomes the signed-in home** when there's a live reservation:
  - One card per live trip, with the trip name, status in plain words
    ("Lugar apartado — vence el mar 14, 13:00" / "Lugar asegurado"), the amount
    owed, and the single next action.
  - Past, cancelled, and expired reservations are grouped below, without an
    owed amount.
  - Credit appears here as its own line when non-zero.
- **The reservation detail becomes the trip's hub**, in this order:
  1. Trip header (name, dates, cover).
  2. Status explainer.
  3. **One primary next action** (pay deposit · pay an installment · open the
     pending voucher · nothing due).
  4. Money summary (total / paid / owed / deadline / suggested monthly).
  5. Payments with receipts inline.
  6. Cancellation last.

  Payment history stops being a separate screen.
- **Trip detail** carries what the traveler needs before committing: deposit,
  hold length, payment deadline, suggested monthly. «Reservar» turns into «Ver
  mi reserva» if they already have one.
- **Auth is an interruption, not a destination:** every guard, login,
  register, verify, and invitation step returns to where the traveler was
  going.
- **Inbox items deep-link** to the reservation, the pay action, or credit.

### 3.3 Admin, current

```
toolbar: logo(→ /) · language · user name · sign out
sidenav (flat, permission-filtered, in this order):
  Viajes        /trips            list → /trips/new | /trips/:id (edit) | :id/images | :id/costing | :id/price-change
  Reservas      /reservations     list → /reservations/:id (detail: request, cancel, cash, credit, payments, receipts)
  Clientes      /customers        list → /customers/new | /customers/:id (data, account, reservations, credit, counter reservation, backfill)
  Importaciones /imports          list+upload → /imports/:batchId
  Administradores /staff          list → new | :id
  Roles         /roles            list → new | :id
  Agencia       /settings/organization
/ → /trips   ·   /forbidden → button to / (loops without trip.view)
```

Cross-links that exist:
- reservation → customer (`reservation-detail.component.html:78`)
- customer → reservation (`customer-detail.component.html:55`)
- price-change preview → reservation

Cross-links that don't exist:
- trip → its reservations/passengers
- reservation → trip
- credit entry → reservation
- any list → "create from this search"

### 3.4 Admin, proposal (structure only)

- **Mostrador** (home for any role with `customer.view` or `reservation.view`):
  - One search box for customer name / email / phone **and** reservation code.
  - Today's queue: holds expiring today · cancellation requests · orphan
    payments · overdue balances.
  - Three quick actions: **Cobrar**, **Nuevo cliente**, **Apartar lugar**.
- **Ventas**
  - *Reservas*, with saved views instead of raw filters: Por cobrar ·
    Apartados por vencer · Solicitudes de cancelación · Todas.
  - *Clientes*.
- **Viajes**
  - The list opens a **trip hub** with tabs: Resumen (seats, money collected
    and owed, passengers) · Contenido · Fotos · Costeo · Precio.
  - A **publish checklist** where each missing item links to its tab.
  - The read-only Resumen opens with `trip.view`.
- **Datos:** Importaciones + Captura histórica (one place for backfill).
- **Configuración:** Personal · Roles · Agencia.
- **Avisos del personal** in the toolbar with a badge, backed by the existing
  inbox rows.
- **Landing by permission:** first allowed section, never `/forbidden`.
- **Customer detail as the account hub:**
  - Reservations with the owed amount and an inline «Cobrar» per live **or
    expired** row.
  - Credit with apply, refund, and adjust together.
  - Backfill moved out to Datos.

---

## 4. Data gaps between API and UI

### 4.1 The API returns it, the UI doesn't show it

| Screen | Unused fields (schema) | Why it matters |
|---|---|---|
| Client reservation list | `holdExpiresAt`, `paidCents`, `totalPriceCents`, `paymentDeadline` (`ReservationSummary`, `schema.d.ts:5312-5332`) | A countdown and the next payment could live on the list or the home screen without opening each reservation. |
| Client reservation detail | `cancellationReason` (the traveler's own), `createdAt` | Minor context. |
| Client payment history | `voucherExpiresAt`, `provider` (`Payment`, `:5483-5503`) | The pending-voucher deadline is the one date that decides whether the seat survives. |
| Client credit | `reservationId`, `paymentId`, `reason` per entry (`:5759-5775`) | «¿De dónde salió este saldo?» |
| Client inbox | `eventType`, `status`, `sentAt` (`:5798-5816`) | `eventType` is enough to choose an icon and a next action. |
| Client sign-in | `POST /auth/oauth/google`, `/auth/oauth/apple` | Built (PRODUCT.md lists it) but no button. |
| Client pay | `SPEI` method (`:5409`) | Bank transfer is common in Mexico; it's the only non-card option that works on an `ACTIVE` reservation (no voucher expiry). Needs an instructions screen. |
| Admin reservation list | `tripDepartureDate`, `holdExpiresAt`, `paidCents`, `totalPriceCents`, `paymentDeadline`, `customerId`, `createdAt` (`:5411-5437`) | Enough for "who owes" and "expiring today" views, sorted client-side, without a new endpoint. |
| Admin reservation detail | `minimumDepositCents`, `createdAt` (`:5445-5482`) | Deposit threshold at the counter (job 1). |
| Admin customer detail | `locale`, `emailVerifiedAt`, `acceptedTermsAt`, `createdAt`, `origin` badge context (`:5721-5758`) | Explains why a customer can't reserve in the app (unverified) and which language their receipts go out in. |
| Admin customer list | `origin`, `createdAt`, `activatedAt` (`:5649-5669`) | Minor. |
| Admin import list | `rowsFailed`, `sendEmails`, `appliedAt` (`:5584-5600`) | Shows `rowsOk / rowsTotal` only. |
| Staff notices | `INBOX` rows for every `notifyAdmins` recipient (`delivery-service.ts:127-147,197-213`), readable through `GET /notifications`, which is ownership-scoped for any actor (`apps/api/src/app/api/v1/notifications/route.ts:11,39`) | The staff inbox needs **no new API**, only a screen. |

### 4.2 The UI needs it, the API doesn't return it

| Screen | Missing | Where it lives today |
|---|---|---|
| Client catalogue + trip detail | `minimumDepositCents`, `holdTtlHours`, `paymentDeadline` (and a suggested monthly preview) | `Trip` columns (`schema.prisma:319-323`); not in `PublicTripSummary`/`PublicTripDetail` |
| Client reserve, before the hold | Amounts preview without creating the hold | Only computed on the created reservation |
| Client reservation detail | Trip name, slug, dates, cover | `ReservationSummary` has `tripName` + `tripDepartureDate`; `ReservationDetail` has only `tripId` (`schema.d.ts:5333-5360`) |
| Client reservation detail | This reservation's pending payments (voucher URL + expiry) | Only through `GET /payments` (every reservation of the customer, filtered client-side in `payment-history.component.ts:37`) |
| Client pay | Pay an arbitrary amount / an installment; OXXO on `ACTIVE` | Intent enum `FULL | DEPOSIT` only; the OXXO voucher is tied to `holdExpiresAt` (top finding 1). **Product decision.** |
| Client pay (SPEI) | Transfer instructions (CLABE, reference, amount, expiry) | Not in `CreatedPaymentIntent` |
| Client inbox | `reservationId` per item | Column exists on `notification_deliveries` (`notifications.md:272-293`); not serialized |
| Client profile | `locale` (read + write) | Not in `CustomerProfile`; the client can't change its language |
| Admin reservations | Text search (code, customer), pagination, sort | Query takes `tripId`, `status`, `cancellationPending` only (`schema.d.ts:2673-2677`) |
| Admin reservation detail | `source` (app / counter / backfill), created by, this reservation's credit movements | Columns exist (`Reservation.source`, `createdById`, `customer_credit_entries.reservation_id`); not returned |
| Admin payment rows | `paidAt` vs `recordedAt` both, `recordedBy`, `notes` | `Payment` has `paidAt`/`recordedAt`; the admin table shows `recordedAt` only; `recordedById` and `notes` aren't serialized |
| Admin customer search | Live reservations count / total owed per customer | Not in `CustomerPage` |
| Admin counter reservation | Trip id, deposit, deadline, hold length for published trips | Uses the public catalogue (no id, no deposit); `TripSummary` (`schema.d.ts:5095-5107`) lacks them too |
| Admin trips list / hub | Money collected and owed per trip, passenger count | No aggregate endpoint (Phase 3B reports may cover it) |
