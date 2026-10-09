# Admin redesign: API gap analysis

- **Author:** Bravo (read-only analysis, no code changed)
- **Source:** `main` at `7f28333`, read on 2026-10-07. The IA comes from
  `apps/admin/.impeccable/surfaces/apps-admin.md` («IA this redesign owns») on
  `redesign/direction` (`eba78b1`). Starting facts come from
  `.impeccable/review/flow-inventory.md` §2-4 (Echo), re-checked against the code.
- **Scope:** what the API offers today for each IA element, what is missing, and a
  proposed contract for each gap (route, query, Zod response, permission key,
  pagination, indexes) with the domain service that should own it.
- **Conventions assumed (all precedented in the code):**
  - Routes live in `apps/api/src/app/api/v1/**/route.ts` and use `route({ permission, handler })`
    (`apps/api/src/lib/http/route.ts`). `route()` only validates JSON bodies, so a GET validates its
    query by hand against a Zod schema from `@rm/contracts` (`admin/reservations/route.ts:28-46`).
  - A route does four things and nothing more (CLAUDE.md). Rules live in `libs/domain/<module>`.
  - Every new response shape needs three edits: the Zod schema in `libs/contracts`, its registration
    plus the `DateToString` parity type in `apps/api/src/lib/openapi/registry.ts` (pattern at
    `registry.ts:383-387`), then `pnpm api:types` and a wrapper in `libs/api-client`.
  - "Today" means today in `SystemSetting.organization.timezone`
    (`organizationTimeZone`, `libs/domain/settings/src/lib/organization-timezone.ts`), computed with Luxon
    like `customer-service.ts:253` and `import-service.ts:99`. Calendar-date comparisons use
    `calendarDay()` / `isPastDate()` from `@rm/shared-utils`.
  - Touching `libs/domain/<module>/src` means updating the matching `docs/business-rules/*.md` and diagram
    in the same commit (CLAUDE.md table).

## 0. Summary

| # | IA element | Today | Missing | Complexity |
|---|---|---|---|---|
| 1 | Mostrador global search | Customer search only; no reservation search; no receipt lookup | One typeahead endpoint across customers, reservations and receipts, plus 2 prefix indexes | **complex** |
| 2a | Queue: holds expiring today | Nothing date-aware; the list returns every reservation | `view=HOLDS_EXPIRING_TODAY` on the reservation list, pagination, partial index | simple |
| 2b | Queue: payments PENDING | Per-reservation only, behind `payment.view` | `GET /admin/payments?status=PENDING`, partial index | simple |
| 2c | Queue: late money awaiting a decision | Alerts only; nothing persists "still unresolved" | New case record with resolve action, webhook + revival changes | **complex** |
| 2d | Queue: overdue balances | Nothing; staff scan the unpaginated list by hand | `view=OVERDUE` on the reservation list, partial index | simple |
| 2e | Queue: cancellation requests | **Exists**: `?cancellationPending=true`, sorted oldest first | Pagination only (optional) | none |
| 2f | Badge counts | None | `GET /admin/work-queue/summary` | simple (4 counts); the 5th waits on 2c |
| 3 | Staff inbox | **Works today** through `GET /notifications` | `reservationId` on each item, mark-all-read (optional), wider recipients (decision) | simple |
| 4 | Trip hub | Trip, costing, price-change, images, reservations-by-trip all exist | `GET /trips/{tripId}/summary` (seats and money) | simple |
| 5 | Reservation MRZ strip | **All six fields are in `StaffReservationDetail`** | Nothing blocking; three optional extras | none |

Missing endpoints, in build order: `GET /admin/work-queue/summary`, `GET /admin/payments`,
`view` and pagination on `GET /admin/reservations`, `GET /trips/{tripId}/summary`, inbox additions,
`GET /admin/search`, and the late-money case (`GET /admin/late-payments`,
`POST /admin/late-payments/{id}/resolve`).

---

## 1. Mostrador global search (name, phone, email, RM- code)

### What exists

| Capability | Where | Notes |
|---|---|---|
| Customer search by name, email, phone | `GET /api/v1/admin/customers?search&page&pageSize`, `admin/customers/route.ts:18-35`, permission `customer.view` (`:19`) | `searchCustomers`, `libs/domain/customers/src/lib/customer-service.ts:117-163`. Accent- and case-insensitive (`fold` `:82`, `ACCENTED`/`PLAIN` `:88-89`, `likePattern` `:91`). Phone matches on digits when the query has at least 3 (`:126-129`). Page size capped at 50 (`:75`; Zod `libs/contracts/src/lib/customers.ts:8-12`). Matches with `LIKE '%x%'` on expressions, so a sequential scan; fine at agency scale. |
| Customer row | `customerSummarySchema`, `customers.ts:15-25` | `id, fullName, email, phone, origin, activatedAt, invitedAt, hasPassword, createdAt`. **No reservation count, no money owed.** Echo §2 job 3 already flagged this. |
| Reservation list | `GET /api/v1/admin/reservations?tripId&status&cancellationPending`, `admin/reservations/route.ts:28-46`, permission `reservation.view` | `listReservationsForStaff`, `reservation-service.ts:796-826`. Filter schema `reservations.ts:87-94` has **no text filter and no pagination** (the doc comment at `:781-795` says so on purpose). |
| Lookup by reservation code | `Reservation.code` is `@unique` (`libs/db/prisma/schema.prisma:435`), format `RM-XXXX-XXXX` (`reservation-code.ts`) | Indexed for exact match only. **No endpoint exposes it.** |
| Lookup by receipt number | `Payment.receiptNumber` is `@unique` (`schema.prisma:509`), format `{prefix}-{year}-{000001}` | **No endpoint**: payments are only listed per reservation (`admin/reservations/[reservationId]/payments/route.ts:14-18`, `payment.view`) or per customer (`payments/route.ts:12`, ownership only). |

### Gap

One box, one request, three result kinds. Nothing resolves a typed `RM-7K3D-9XQF` or a receipt folio
to a reservation, and nothing searches reservations by customer. Each keystroke would otherwise cost
a customer search plus a full reservation list filtered in the browser.

### Proposed contract

`GET /api/v1/admin/search?q=&limit=`

- **Permission:** `anyPermission: ['customer.view', 'reservation.view']` at the route; the service then
  returns each group only if the actor holds its permission: customers need `customer.view`,
  reservations need `reservation.view`, and a receipt-number match needs `payment.view` (payments
  are gated separately, `payments` category in `permissions.ts:39-41`). A group the actor may not see
  comes back as `null`, not as an empty list, so the UI can tell "none found" from "not allowed".
- **Query:** `q` trimmed, 2 to 120 characters; `limit` is per group, default 5, max 10. No pagination:
  this is a typeahead, and "see all results" links to the existing list screens with the same text.

```ts
export const adminSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export const searchCustomerHitSchema = z.object({
  id: uuidSchema,
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  matchedOn: z.enum(['NAME', 'EMAIL', 'PHONE']),
  liveReservations: z.number().int(),   // HELD (unexpired) + ACTIVE
  owedCents: z.number().int(),          // sum of balance over those
});

export const searchReservationHitSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  customerId: uuidSchema,
  customerName: z.string(),
  tripName: z.string(),
  tripDepartureDate: z.iso.datetime(),
  status: reservationStatusSchema,
  totalPriceCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  holdExpiresAt: z.iso.datetime().nullable(),
  matchedOn: z.enum(['CODE', 'RECEIPT', 'CUSTOMER']),
  receiptNumber: z.string().nullable(),  // set when matchedOn = RECEIPT
});

export const adminSearchResponseSchema = z.object({
  query: z.string(),
  customers: z.array(searchCustomerHitSchema).nullable(),
  reservations: z.array(searchReservationHitSchema).nullable(),
  truncated: z.object({ customers: z.boolean(), reservations: z.boolean() }),
});
```

- **How the query is read** (server side, so every client behaves the same):
  - Normalise: uppercase, trim, accept `RM7K3D9XQF` as `RM-7K3D-9XQF`.
  - Matches the reservation-code shape (a prefix of it, using the generator's alphabet in
    `reservation-code.ts`): prefix-match `reservations.code`.
  - Matches `^{receipt.prefix}-\d{4}-\d{0,6}$`: prefix-match `payments.receipt_number`, then return the
    owning reservation with `matchedOn: 'RECEIPT'`. `receipt.prefix` is a `SystemSetting`, so read it,
    don't hardcode `RM`.
  - Otherwise: customers by the existing name/email/phone rules (reuse `fold` and `likePattern`), plus
    that customer's live reservations as `matchedOn: 'CUSTOMER'` (cap them by `limit`).
  - Voucher codes (`pi_…`, `providerIntentId`, `schema.prisma:500`) are Stripe's, not the agency's. Out
    of scope unless the owner says counter staff read them off a screen.
- **Indexes:**
  - `CREATE INDEX reservations_code_prefix ON reservations (code text_pattern_ops);`
  - `CREATE INDEX payments_receipt_number_prefix ON payments (receipt_number text_pattern_ops) WHERE receipt_number IS NOT NULL;`
    The existing unique indexes serve equality but not `LIKE 'RM-7K%'` under a non-C collation.
  - Customers: nothing now. If the customer count passes tens of thousands, add a `pg_trgm` GIN index on
    the same `translate(lower(...))` expressions the query uses (no extension is installed today; no
    `CREATE EXTENSION` exists in `libs/db/prisma/migrations`).
- **Domain home:** `@rm/domain-customers` as `searchForCounter`. It already owns `fold`/`likePattern`
  and the counter-sale flow; reading `reservations` and `payments` through the shared Prisma client adds
  no library edge (today `customers` depends on `audit`, `identity`, `settings` only; `reservations`
  and `payments` don't import `customers`). A separate `libs/domain/search` would also need a new row
  in the CLAUDE.md table and in `docs-guard.yml`. Docs to update: `docs/business-rules/customers.md`
  and `docs/diagrams/counter-sale.md`.
- **Complexity: complex.** It is the only cross-aggregate read, it classifies input, it gates three result
  groups by permission, it needs two index migrations, and it runs on every keystroke.
- **Cheap interim step (simple):** add `search` (reservation code or customer name) to
  `listStaffReservationsQuerySchema` for the Reservas tab and the trip hub.

---

## 2. Work queue

All five lists share one shape on screen (reservation code, customer, trip, one money figure, one
due-by moment, one action), so the UI can render them uniformly. The API does not need a single
polymorphic endpoint to support that; the lists belong to different domains.

### 2a. Holds expiring today (org timezone)

- **Exists:** `holdExpiresAt` on the summary (`staffReservationSummarySchema`, `reservations.ts:115-132`;
  column `schema.prisma:441`). The list can filter by status but not by date, and returns every row.
  The expiry job runs every 5 minutes (`apps/worker/src/main.ts:89`) and sets `status=EXPIRED,
  holdExpiresAt=null` (`apps/worker/src/jobs/expire-holds.ts:57`), so an expired hold loses its timestamp.
  `warnExpiringHolds` uses a different window, a quarter of the trip's TTL (`warn-expiring-holds.ts:17-19`).
- **Missing:** a date-aware filter.
- **Proposal:** extend `GET /api/v1/admin/reservations` (same permission, `reservation.view`) with
  `view=HOLDS_EXPIRING_TODAY`. Definition: `status = 'HELD' AND hold_expires_at < startOfTomorrow(orgTz)`,
  oldest first. It includes holds already past but not yet swept (up to 5 minutes), flagged by the UI as
  "vence ya". Computing the bound: `DateTime.now().setZone(tz).plus({ days: 1 }).startOf('day')`.
- **Index:** `CREATE INDEX reservations_held_expiry ON reservations (hold_expires_at) WHERE status = 'HELD';`
  (the only existing indexes on `reservations` are `tripId` and `customerId`, `schema.prisma:479-480`).
- **Home:** `@rm/domain-reservations` (`listReservationsForStaff`). Docs: `reservations.md`,
  `trip-reservation.md`.
- **Complexity: simple.**

### 2b. Payments PENDING

- **Meaning to confirm with the owner.** A `PENDING` payment is an OXXO/SPEI voucher or a card intent that
  was opened and not yet confirmed (`PaymentStatus`, `schema.prisma:85-91`). Staff cannot confirm it: a
  payment exists only when Stripe says so through the webhook (CLAUDE.md, «La verdad de un pago llega
  por webhook»). So this queue item is "money we are waiting for", with the voucher deadline, not a
  "confirm" button.
- **Exists:** `PaymentContract` has everything needed (`payments.ts:33-45`: `status`, `method`,
  `voucherExpiresAt`, `providerVoucherUrl`, `amountCents`), but only per reservation
  (`admin/reservations/[reservationId]/payments/route.ts:14-18`, `payment.view`;
  `listPaymentsForReservation`, `payment-service.ts:502-510`). No cross-reservation staff listing exists.
- **Proposal:** `GET /api/v1/admin/payments?status=PENDING&method=&cursor=&limit=` (`payment.view`).

```ts
export const listStaffPaymentsQuerySchema = z.object({
  status: paymentStatusSchema.optional(),
  method: paymentMethodSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const staffPaymentRowSchema = paymentSchema.extend({
  reservationCode: z.string(),
  customerId: uuidSchema,
  customerName: z.string(),
  tripName: z.string(),
  reservationStatus: reservationStatusSchema,
});
// page: { items, nextCursor }
```

  Order: `voucherExpiresAt` ascending (nulls last), then `recordedAt`. Keyset cursor `(sortKey, id)`, the
  same pattern as the inbox (`delivery-service.ts:87-107`, `:313-337`). Card intents that were opened and
  abandoned are noise; the queue view should default to `method IN (OXXO, SPEI)` or `recordedAt` older
  than an hour flagged `STALE`, owner's call.
- **Index:** `CREATE INDEX payments_pending ON payments (voucher_expires_at) WHERE status = 'PENDING';`
  (`payments` is indexed on `reservationId` only, `schema.prisma:532`).
- **Home:** `@rm/domain-payments` (`listPaymentsForStaff`). Docs: `payments.md`, `payment-flow.md`.
- **Complexity: simple.**

### 2c. Late money after expiry or cancellation, awaiting a human decision

- **What the code does today.** A payment confirmed after the fact is recorded as `SUCCEEDED`, and
  `paid_cents` rises:
  - Reservation `EXPIRED` (`webhook-handler.ts:236-257`): no credit is written, the customer gets
    `PAYMENT_AFTER_EXPIRY`, staff get `ORPHAN_PAYMENT`. The rule says a person must decide: revive, or
    `ADJUSTMENT` plus `REFUND` (`docs/business-rules/payments.md:158-214`).
  - Reservation `CANCELLED` (`:259-292`): the money is credited automatically (`creditFromCancellation`,
    `:268`), customer gets `PAYMENT_AFTER_CANCELLATION`, staff still get `ORPHAN_PAYMENT`.
- **Missing: any durable "still unresolved" signal.** The staff alert is a notice row, not a case, and it
  can be read without being resolved. The state can't be derived either:
  - A late payment on an `EXPIRED` reservation leaves `status=EXPIRED, paid_cents>0`, and so does an
    ordinary expiry that was credited (`expire-holds.ts:73-84`, `credit-service.ts:405-418`).
  - The expiry timestamp is gone (`expire-holds.ts:57`), so "paid after expiry" can't be told apart by time.
  - After the `ADJUSTMENT` + `REFUND` path, the reservation stays `EXPIRED` with the same `paid_cents`
    (payments.md says so), so a query on those columns would never drop the row from the queue.
  - `CustomerCreditEntry.paymentId` exists (`schema.prisma:564`) but nothing guarantees an adjustment sets it.
- **Proposal: an explicit case record**, opened in the same transaction as the webhook branch and closed
  by a human action (or automatically when the reservation is revived).

```prisma
enum LatePaymentKind { AFTER_EXPIRY  AFTER_CANCELLATION }
enum LatePaymentResolution { REVIVED  REFUNDED  KEPT_AS_CREDIT  DISMISSED }

model LatePaymentCase {
  id            String   @id @default(uuid()) @db.Uuid
  paymentId     String   @unique @map("payment_id") @db.Uuid
  reservationId String   @map("reservation_id") @db.Uuid
  kind          LatePaymentKind
  openedAt      DateTime @default(now()) @map("opened_at") @db.Timestamptz
  resolvedAt    DateTime? @map("resolved_at") @db.Timestamptz
  resolvedById  String?  @map("resolved_by") @db.Uuid
  resolution    LatePaymentResolution?
  note          String?
  @@index([resolvedAt, openedAt])   // partial in SQL: WHERE resolved_at IS NULL
  @@map("late_payment_cases")
}
```

  - `GET /api/v1/admin/late-payments?state=OPEN|RESOLVED&cursor&limit`, permission `payment.view`.
    Row: the case plus `paymentId, amountCents, method, paidAt, receiptNumber, reservationId,
    reservationCode, reservationStatus, customerId, customerName, tripName`.
  - `POST /api/v1/admin/late-payments/{caseId}/resolve` with `{ resolution, note }`, permission
    `payment.credit.apply` (the key already gates credit moves, `permissions.ts:41`).
  - Revival (`libs/domain/reservations/src/lib/revival.ts`, the `reviveReservationSeat` hook) closes the
    case with `REVIVED` in the same transaction. `AFTER_CANCELLATION` cases are already credited, so they
    open as informational and are closed by acknowledging.
  - **Decision for the owner:** do `AFTER_CANCELLATION` cases belong in the queue at all, given the money
    is already credited? Today staff still receive `ORPHAN_PAYMENT` for them.
- **Home:** `@rm/domain-payments` (webhook handler writes the case; `resolveLatePayment` closes it), with a
  small revival hook in `@rm/domain-reservations`. Docs: `payments.md` (new state and the two exits),
  `reservations.md` (revival closes the case), `payment-flow.md`.
- **Complexity: complex.** Migration, two domains, the webhook's idempotency tests, docs, and a backfill
  decision for cases that predate it (there is no durable record to backfill from).

### 2d. Overdue balances (past payment deadline, balance > 0)

- **Exists:** `paymentDeadline` (`@db.Date`) and `balanceCents` on every summary row (`reservations.ts:115-132`).
  The deadline rule is enforced only at creation (`reservation-service.ts:374`, `PAYMENT_DEADLINE_PASSED`);
  nothing in the worker acts when a deadline passes (`apps/worker/src/main.ts:89-92`). `reservation.risk.view`
  exists for «collection-risk alerts» (`permissions.ts:37`; the daily alert is Phase 3A, spec
  `2026-09-28-agencia-viajes-diseno.md:341`), but no endpoint or screen uses it.
- **Missing:** a date-aware filter and a sort.
- **Proposal:** `view=OVERDUE` on `GET /api/v1/admin/reservations`: `status IN ('HELD','ACTIVE') AND
  payment_deadline < :today AND total_price_cents > paid_cents`, where `:today` is the org-timezone
  `YYYY-MM-DD` string (a date column compares against a date, never an instant; same reasoning as
  `isPastDate`, `libs/shared-utils/src/lib/calendar.ts:43-52`). Order: deadline ascending, then balance
  descending. Permission `reservation.view`; the Phase 3A «at risk before the deadline» variant can
  later take `reservation.risk.view`.
- **Index:** `CREATE INDEX reservations_live_deadline ON reservations (payment_deadline) WHERE status IN ('HELD','ACTIVE');`
- **Home:** `@rm/domain-reservations`. Docs: `reservations.md`, `trip-reservation.md`.
- **Complexity: simple.**

### 2e. Pending cancellation requests

- **Exists:** `GET /api/v1/admin/reservations?cancellationPending=true`
  (`admin/reservations/route.ts:35-39`; logic `reservation-service.ts:803-825`; flag `isCancellationPending`
  `:735-741`). Sorted oldest request first, because the list puts pending rows first (`:822-826`). Staff
  are notified by `CANCELLATION_REQUESTED` (`reservation-service.ts:684`).
- **Missing:** pagination (the unpaginated list is the same one the table uses). The shared `view`
  parameter below would also cover it: `view=CANCELLATION_PENDING` as an alias.
- **Complexity: none** for the data; reuse.

### 2f. Counts for badges

- **Exists:** none for staff. The inbox returns `unreadCount` (`delivery-service.ts:336`,
  `notifications.ts:40-44`).
- **Proposal:** `GET /api/v1/admin/work-queue/summary`, one request polled every 60 seconds.

```ts
export const workQueueSummarySchema = z.object({
  asOf: z.iso.datetime(),
  timeZone: z.string(),                          // the org zone "today" was evaluated in
  holdsExpiringToday: z.number().int().nullable(),   // reservation.view
  overdueBalances: z.number().int().nullable(),      // reservation.view
  cancellationRequests: z.number().int().nullable(), // reservation.view
  pendingPayments: z.number().int().nullable(),      // payment.view
  latePayments: z.number().int().nullable(),         // payment.view; null until 2c ships
  inboxUnread: z.number().int(),                     // own INBOX rows
});
```

  A count is `null` when the actor lacks its permission, so the UI hides the badge instead of showing 0.
  Implementation: one `reservations` query with `count(*) FILTER (WHERE …)` per category plus one on
  `payments` and one on `notification_deliveries`; the partial indexes above keep it cheap.
  Every number must use exactly the same predicate as its list endpoint, so a badge never disagrees with
  the screen it opens. Share the predicate builders between the two.
- **Home:** an aggregator is needed because `reservations` and `payments` don't import each other
  (and shouldn't). Two options:
  1. Each domain exports a count function (`countQueueForStaff` in reservations and in payments) and the
     route composes them with `Promise.all` plus `unreadCount`. There is precedent for a route wiring two
     domains (`admin/reservations/route.ts:53-67`).
  2. A new read-only `libs/domain/work-queue`. Cleaner, but it needs a docs file
     (`work-queue.md`), a CLAUDE.md table row and a `docs-guard.yml` change.

  Recommendation: option 1.
- **Complexity: simple** for four counts; the fifth waits for 2c.

---

## 3. Staff inbox

### Can staff read the `notifyAdmins` INBOX rows through `GET /notifications` today?

**Yes.** Verified end to end:

- **Writing:** `notifyAdmins` creates an `INBOX` row (status `SENT`) and an `EMAIL` row per eligible staff
  user (`delivery-service.ts:130-160` `deliverToUser`, `:197-213`). Eligible means `type='STAFF'`,
  `status='ACTIVE'` and a role holding `reservation.cancel` (`ADMIN_ALERT_PERMISSION`, `:69`).
- **Reading:** `GET /api/v1/notifications` has **no `permission` option** (`notifications/route.ts:27`), so any
  authenticated actor passes. `listInbox` filters by `userId = actor.userId` and `channel = 'INBOX'`
  (`delivery-service.ts:313-337`), which is exactly the staff user's own rows. The response includes
  `unreadCount` over all pages (`:336`), paged by an opaque cursor (`:87-107`, `listInboxQuerySchema`
  `notifications.ts:20-23`).
- **Marking read:** `POST /api/v1/notifications/{deliveryId}/read` (`notifications/[deliveryId]/read/route.ts:13`)
  works for staff for the same reason (`markRead`, `delivery-service.ts:352-362`; others' rows answer
  `DELIVERY_NOT_OWNED`).
- **Which events staff receive:** only the three `notifyAdmins` callers: `CANCELLATION_REQUESTED`
  (`reservation-service.ts:684`), `ORPHAN_PAYMENT` (`webhook-handler.ts:97`), `PAID_CENTS_MISMATCH`
  (`apps/worker/src/jobs/reconcile-paid-cents.ts:53`).

The client app uses the same endpoint today; the admin has no screen for it
(Echo §2, «Global facts»).

### What is missing

| Gap | Detail | Fix | Complexity |
|---|---|---|---|
| **No deep link** | `reservation_id` is stored on the row (`schema.prisma:656`) but `InboxItemDto` (`delivery-service.ts:38-47`) and `inboxItemSchema` (`notifications.ts:28-37`) don't carry it. `eventType` is returned and is enough to pick the action. | Add `reservationId: uuidSchema.nullable()` to the DTO, the schema, `toInboxItemDto` (`:74-85`) and the registry parity type. Additive, so the client app is unaffected. | simple |
| **No mark-all-read** | A queue-style inbox needs it. | `POST /api/v1/notifications/read-all` (204, no permission, scoped to the actor). | simple |
| **No unread-only filter** | Same cursor endpoint. | Optional `unreadOnly=true` on `listInboxQuerySchema`. | simple |
| **Narrow recipients** | Only `reservation.cancel` holders get alerts. `ORPHAN_PAYMENT` and `PAID_CENTS_MISMATCH` are money events; `payment.view` or `payment.credit.apply` holders arguably should see them, and `reservation.risk.view` is unused. | Decision for the owner. If yes, change `notifyAdmins` to take the permission per event (`delivery-service.ts:69`, `:203-207`) and update `notifications.md`. | simple, but a business-rule change |
| **Badge poll** | The unread count rides on the list. | Folded into `inboxUnread` in the work-queue summary (2f), so one poll serves both badges. | none extra |

No new inbox endpoint is needed for the first version. The queue (section 2) is the durable view; the
inbox is the event log, and the two overlap only on cancellation requests and orphan payments.

---

## 4. Trip hub

### What exists per tab

| Tab | Endpoint | Permission | Source |
|---|---|---|---|
| Overview (basics) | `GET /api/v1/trips/{tripId}` | `trip.view` | `trips/[tripId]/route.ts:7-10`. `TripDto` (`trip-service.ts:110-135`): dates, capacity, `preSoldSeats`, `availableSeats`, hold TTL, minimum deposit, budget total, margin, price, status, translations, images. |
| Reservations | `GET /api/v1/admin/reservations?tripId=` | `reservation.view` | `reservations.ts:87-94`. Unpaginated; rows already carry customer, status, paid, balance, deadline. |
| Costing | `GET /api/v1/trips/{tripId}/costing` | `trip.budget.view` | `trips/[tripId]/costing/route.ts:6-8` |
| Images | list is inside `TripDto.images`; `POST` and `DELETE` per image | `trip.update` | `trips/[tripId]/images/route.ts:15-16`, `images/[imageId]/route.ts:12-13` |
| Price change | `GET`/`POST /api/v1/trips/{tripId}/price-change` | `trip.change_price` | `price-change/route.ts:15-21` |

One endpoint per tab already exists, which is the right shape for the tabs. Echo's other trip-hub finding
(a user with `trip.view` but not `trip.update` can't open a trip) is the admin router's
(`trips.routes.ts:22-26`), not the API's: `GET /trips/{tripId}` already needs only `trip.view`.

### Gap: the overview numbers

`TripDto` returns one number, `availableSeats`, which hides the split the hub wants. The pieces are computed
in `countCommittedSeats` (`libs/domain/reservations/src/lib/capacity.ts:92`) and
`availableSeats()` (`:46-51`), then thrown away after subtraction. There is no money rollup per trip
anywhere. (Echo §4.2: «Admin trips list / hub: no aggregate endpoint».)

### Proposal: `GET /api/v1/trips/{tripId}/summary`

- **Permission:** `trip.view`. The `money` block is `null` unless the actor also holds `reservation.view`
  (balances are the `reservations` category, `permissions.ts:34`).
- **No pagination, no query.**

```ts
export const tripSummarySchema = z.object({
  tripId: uuidSchema,
  seats: z.object({
    capacity: z.number().int(),
    preSold: z.number().int(),     // Trip.preSoldSeats (history; no payments rows)
    sold: z.number().int(),        // ACTIVE reservations
    held: z.number().int(),        // HELD with holdExpiresAt > now
    free: z.number().int(),        // availableSeats(): capacity - preSold - sold - held, floored at 0
  }),
  reservations: z.object({         // counts by status, for the tab's chips
    active: z.number().int(),
    heldLive: z.number().int(),
    heldPastDue: z.number().int(), // HELD but not yet swept by the 5-minute job
    expired: z.number().int(),
    cancelled: z.number().int(),
    cancellationRequests: z.number().int(),
  }),
  money: z.object({
    collectedCents: z.number().int(),   // sum paid_cents over live (HELD + ACTIVE) reservations
    pendingCents: z.number().int(),     // sum balance over those
    overdueCents: z.number().int(),     // balance of those past payment_deadline (org tz)
    awaitingVoucherCents: z.number().int(), // PENDING OXXO/SPEI payments on this trip
  }).nullable(),
});
```

- **Semantics to fix in the docs:**
  - "Collected" counts live reservations only. `EXPIRED` and `CANCELLED` reservations moved their money to
    customer credit (`credit-service.ts:405-418` for expiry, cancellation likewise), so including them
    would double count.
  - `paid_cents` is the denormalized sum of `SUCCEEDED` payments, reconciled nightly (`schema.prisma:446-451`,
    worker job at `main.ts:92`), so it is safe to sum.
  - Pre-sold seats carry no payments, so they appear in `seats` but not in `money`.
- **Query cost:** one `groupBy(status)` with `_count` and `_sum` on `reservations WHERE trip_id = ?`
  (covered by `@@index([tripId])`, `schema.prisma:479`), plus one sum on `payments` joined through
  `reservation_id`. No new index.
- **Home:** `@rm/domain-reservations` (`getTripReservationSummary`), next to `capacity.ts`. The `trips`
  library already depends on `reservations` (never the reverse), and the route can call it directly.
  Docs: `reservations.md`; `trips.md` only if the route is described there.
- **Complexity: simple.**

---

## 5. Reservation detail: MRZ money strip

Strip fields: total · abonado · falta · anticipo mínimo · vence (hold expiry) · payment deadline.

`GET /api/v1/admin/reservations/{reservationId}` (`reservation.view`,
`admin/reservations/[reservationId]/route.ts:10-13`) returns `StaffReservationDetail`
(`staffReservationDetailSchema`, `reservations.ts:135-146`), which extends `reservationSchema`
(`reservations.ts:35-58`). The mapper is `toStaffDetailDto` (`reservation-service.ts:764-781`), which spreads
`toDto` (`:267-285`).

| Strip field | Response field | Defined at | Notes |
|---|---|---|---|
| Total | `totalPriceCents` | `reservationSchema`; `schema.prisma:445` | Frozen at creation (`:442-444`). |
| Abonado | `paidCents` | same; `schema.prisma:451` | Sum of `SUCCEEDED` payments. |
| Falta | `balanceCents` | same; `balanceOf` `reservation-service.ts:263-265` | `max(0, total - paid)`. |
| Anticipo mínimo | `minimumDepositCents` | same; `schema.prisma:446` | Frozen at creation. Echo found the old screen didn't show it. |
| Vence (hold) | `holdExpiresAt` (nullable) | same; `schema.prisma:441` | Non-null only while `HELD`. |
| Fecha límite de pago | `paymentDeadline` | same; `schema.prisma:452` | `@db.Date`, serialized as midnight UTC. Render with `rmCalendarDate`, never `DatePipe`. |

**Confirmed: all six are present in `StaffReservationDetail`, with no API change needed.** The payment list
(abonos, recibos) is a separate call gated by `payment.view` (`admin/reservations/[reservationId]/payments/route.ts:14-18`).

Optional extras, none blocking:

- **`suggestedMonthlyCents`** is on the customer detail (`reservationDetailSchema`, `reservations.ts:60-63`) but
  not on the staff one. Useful beside "falta" at the counter. Simple: `suggestedMonthlyForReservation`
  already exists (`payment-service.ts:521-535`).
- **`source` and `createdByName`** (counter, app, backfill) are stored (`schema.prisma:453-454`) and not returned.
- **Expired-at moment:** `expire-holds.ts:57` nulls `holdExpiresAt`, so an `EXPIRED` reservation cannot say
  when it expired. If the strip should read «venció el …», the job would have to stamp an `expiredAt`; today
  the audit log is the only trace.
- **Overpayment:** `balanceCents` is floored at 0 (`reservation-service.ts:263-265`), so an overpaid
  reservation shows `falta = 0` and the excess is only visible as `paidCents > totalPriceCents`.

---

## 6. Cross-cutting notes

1. **Permissions.** Every new route declares its permission, and any list that mixes categories nulls the
   parts the actor can't see instead of failing the whole request. The UI hides for convenience only
   (CLAUDE.md); these nulls are the API-side enforcement.
2. **"Today".** Every date-aware predicate takes the org timezone from `organizationTimeZone()`; none uses
   the server zone. The server-side audit (`fix/server-calendar-dates`) proved the existing calendar
   helpers don't depend on the server zone. A small `todayBounds(timeZone, now)` helper in
   `@rm/shared-utils/calendar.ts` returning `{ today: 'YYYY-MM-DD', startOfToday, startOfTomorrow }` would
   serve 2a, 2d and 4 and give them one spec.
3. **Pagination style.** Offset (`page`, `pageSize`) exists for customers (`customers.ts:8-12`); cursor exists
   for the inbox (`notifications.ts:20-23`); the reservation list is unpaginated by design
   (`reservation-service.ts:781-795`). New queue lists should use the inbox's keyset cursor, because their
   sort keys (deadline, expiry) change while someone works the list.
4. **The reservation list will outgrow "no pagination".** Once the queue adds `view` and the hub embeds it
   per trip, add a `limit` + cursor to `GET /admin/reservations` and keep the current behavior when they
   are absent, so the existing screen keeps working until it is migrated.
5. **Indexes to add in one migration** (all partial or prefix, all cheap to write):
   - `reservations (hold_expires_at) WHERE status = 'HELD'`
   - `reservations (payment_deadline) WHERE status IN ('HELD','ACTIVE')`
   - `reservations (code text_pattern_ops)`
   - `payments (voucher_expires_at) WHERE status = 'PENDING'`
   - `payments (receipt_number text_pattern_ops) WHERE receipt_number IS NOT NULL`
6. **Order to build, if useful:** (a) inbox `reservationId` + summary counts + holds/overdue `view` +
   `GET /admin/payments` + trip summary (all simple, unblock most of Mostrador and the hub); (b) search;
   (c) late-money case, which also needs the owner's answer on `AFTER_CANCELLATION`.

## 7. Decisions needed from the owner or Alpha

1. **Pending payments:** are OXXO/SPEI vouchers the only "to confirm" items, or should abandoned card
   intents show too (and after how long)?
2. **Late money:** confirm the explicit case model (new table), and whether `AFTER_CANCELLATION` cases belong
   in the queue given the money is already credited.
3. **Alert recipients:** should `ORPHAN_PAYMENT` / `PAID_CENTS_MISMATCH` also reach `payment.view` or
   `payment.credit.apply` holders, and should `reservation.risk.view` get the overdue/at-risk alerts?
4. **Search scope:** are receipt folios and reservation codes the only codes counter staff quote, or also
   Stripe voucher/intent ids?
5. **Where the aggregator lives:** count functions composed in the route (recommended) versus a new
   `libs/domain/work-queue` with its own docs row.
