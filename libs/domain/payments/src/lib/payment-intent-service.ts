import type { Db, Reservation, ReservationStatus } from '@rm/db';
import type { PaymentIntentMethod, PaymentProvider } from '@rm/payments-stripe';
import { fail, ok, type Result } from '@rm/shared-utils';
import { recordPayment } from './payment-service';

export type PaymentIntentKind = 'FULL' | 'DEPOSIT';

export interface CreatePaymentIntentInput {
  reservationId: string;
  /** The caller's own user id. Never trusted from a route param -- see `createPaymentIntentForReservation`'s doc comment. */
  customerId: string;
  /**
   * What the customer is asking to pay towards, **never a number of
   * cents**: the amount charged is always computed here, from the
   * reservation's own balance (business rules 5.4/5.5). There is no field
   * on this type a client-supplied amount could travel through.
   */
  intent: PaymentIntentKind;
  method: PaymentIntentMethod;
}

/**
 * What the customer app needs back to finish the checkout: the provider's
 * own intent id and client secret (to drive its SDK), the OXXO voucher
 * fields when that is the method, and the amount this endpoint actually
 * decided to charge -- echoed back so the UI can show "you are paying
 * $X", not so the client can ever supply it.
 */
export interface CreatedPaymentIntentDto {
  providerIntentId: string;
  clientSecret: string;
  amountCents: number;
  method: PaymentIntentMethod;
  voucherUrl?: string;
  voucherExpiresAt?: Date;
}

/**
 * The two statuses an intent may be created against. Mirrors
 * `@rm/domain-reservations`' own `LIVE_STATUSES`, duplicated rather than
 * imported: `@rm/domain-payments` is a leaf (see this module's own doc
 * comment in `payment-service.ts` and `docs/business-rules/payments.md`),
 * and the same "one small constant instead of a dependency" trade already
 * governs the private `balanceOf` this file also re-declares below.
 */
const LIVE_STATUSES: readonly ReservationStatus[] = ['HELD', 'ACTIVE'];

/** Same formula as `payment-service.ts`'s own `balanceOf` -- see this file's note on `LIVE_STATUSES` for why it is not imported instead. */
function balanceOf(reservation: Reservation): number {
  return Math.max(0, reservation.totalPriceCents - reservation.paidCents);
}

/**
 * What to charge for each `PaymentIntentKind`, computed from the
 * reservation alone -- the one rule this whole module exists to enforce
 * (see `createPaymentIntentForReservation`'s doc comment).
 *
 * `DEPOSIT` is the minimum deposit still owed (`minimum_deposit_cents -
 * paid_cents`), floored at zero and capped at the current balance: once the
 * deposit is fully covered the reservation has already turned `ACTIVE`
 * (`payment-service.ts`'s `applyConfirmedPayment`), so this branch only
 * ever has real work to do against a `HELD` reservation.
 */
function amountForIntent(reservation: Reservation, intent: PaymentIntentKind): number {
  const balance = balanceOf(reservation);
  if (intent === 'FULL') return balance;
  const depositOwed = Math.max(0, reservation.minimumDepositCents - reservation.paidCents);
  return Math.min(balance, depositOwed);
}

/**
 * Creates a Payment Intent with the provider and a matching `PENDING`
 * `Payment` row for one of the caller's own reservations (spec §9) -- the
 * entry point of the whole payment flow: every later step (the webhook
 * confirming it, the counter screen showing its voucher) starts from the
 * row this writes.
 *
 * **The amount is never a client input.** `CreatePaymentIntentInput` has no
 * `amountCents` field -- see `amountForIntent` -- so there is nothing in
 * this function's own signature a route handler could even be tempted to
 * forward from a request body. This is the one property Ruling 2 exists to
 * protect: a customer decides *what* they are paying towards (the full
 * balance or the minimum deposit), never *how much*.
 *
 * **Ownership lives here, not in the route.** A reservation that does not
 * exist and one that belongs to someone else answer the identical
 * `RESERVATION_NOT_OWNED` (404, never 403 -- see `problem.ts`), the same
 * reasoning `@rm/domain-reservations`' `getReservationForCustomer` already
 * uses: a 403 would confirm the id is real. `@rm/domain-payments` cannot
 * call that function directly (this module is a leaf), so the same check is
 * repeated here against the `Reservation` row this function already reads.
 * A `STAFF` caller is blocked by the exact same check: a staff user's id
 * never equals a reservation's `customer_id`, so there is no separate
 * actor-type branch to maintain.
 *
 * **A terminal reservation refuses.** `CANCELLED` and `EXPIRED` cannot
 * start a new payment -- `INVALID_STATUS_TRANSITION`, the same code
 * `requestCancellation` uses for the equivalent shape of "nothing left to
 * do here".
 *
 * **OXXO never outlives the hold.** `voucherExpiresAt` is always the
 * reservation's own `holdExpiresAt`, which `PaymentProvider.createIntent`'s
 * contract promises never to extend (business rule 5.3). When less than a
 * day remains, `StripePaymentProvider` refuses the whole request rather
 * than round the window up past the hold -- this function does not catch
 * that refusal specially, because it does not need to: the provider already
 * returns a `Result`, which flows straight back out as this function's own
 * `VALIDATION_FAILED`, never a thrown exception (see
 * `payment-intent-service.spec.ts`, "surfaces the real Stripe adapter...").
 * A reservation with no `holdExpiresAt` at all (an `ACTIVE` one) hits the
 * same clean refusal, for the same underlying reason: there is no
 * `voucherExpiresAt` to send, and `createIntent` requires one for OXXO.
 */
export async function createPaymentIntentForReservation(
  db: Db,
  provider: PaymentProvider,
  input: CreatePaymentIntentInput
): Promise<Result<CreatedPaymentIntentDto>> {
  const reservation = await db.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation || reservation.customerId !== input.customerId) {
    return fail('RESERVATION_NOT_OWNED');
  }
  if (!LIVE_STATUSES.includes(reservation.status)) {
    return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
  }

  const amountCents = amountForIntent(reservation, input.intent);
  if (amountCents <= 0) {
    // Only reachable for `DEPOSIT` once the minimum is already fully paid,
    // or for `FULL` once the balance is already zero -- both mean there is
    // genuinely nothing left to charge, not a number worth sending to the
    // provider.
    return fail('VALIDATION_FAILED', { field: 'intent', reason: 'nothing_due' });
  }

  const customer = await db.user.findUniqueOrThrow({ where: { id: input.customerId }, select: { email: true } });

  const created = await provider.createIntent({
    reservationId: reservation.id,
    amountCents,
    method: input.method,
    customerEmail: customer.email,
    voucherExpiresAt: input.method === 'OXXO' ? reservation.holdExpiresAt ?? undefined : undefined,
  });
  if (!created.ok) return created;

  const recorded = await db.$transaction((tx) =>
    recordPayment(tx, {
      reservationId: reservation.id,
      amountCents,
      method: input.method,
      status: 'PENDING',
      provider: 'STRIPE',
      providerIntentId: created.value.providerIntentId,
      providerVoucherUrl: created.value.voucherUrl,
      voucherExpiresAt: created.value.voucherExpiresAt,
    })
  );
  if (!recorded.ok) return recorded;

  return ok({
    providerIntentId: created.value.providerIntentId,
    clientSecret: created.value.clientSecret,
    amountCents,
    method: input.method,
    voucherUrl: created.value.voucherUrl,
    voucherExpiresAt: created.value.voucherExpiresAt,
  });
}
