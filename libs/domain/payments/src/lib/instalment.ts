import { roundUpToPeso, type Cents } from '@rm/shared-utils';

/**
 * The instalment the app suggests for the current month (§5.4 of the Phase 2A
 * design spec).
 *
 * ```
 * suggested_monthly_cents = min(balance_cents,
 *                               roundUpToPeso(balance_cents / max(months_remaining, 1)))
 * ```
 *
 * `monthsRemaining` is the number of first-of-month days left before the
 * payment deadline -- `monthStartsBetween` in `@rm/shared-utils` counts them
 * in the organisation's timezone. `suggestedMonthlyForReservation` in
 * `payment-service.ts` puts the two together; this function is the arithmetic
 * alone, so it can be read and tested without a database.
 *
 * Three properties the callers depend on:
 *
 * - **It rounds up, never down.** Rounding down leaves the customer short by
 *   up to a peso every month, and the instalments then do not add up to the
 *   total -- the last month would silently owe more than the plan said.
 * - **It never exceeds the balance.** Rounding up can overshoot a small or
 *   fractional balance (100.50 over one month rounds to 101.00), and
 *   `recordPayment` rejects anything above the balance with
 *   `PAYMENT_EXCEEDS_BALANCE`. Suggesting an amount the API would refuse is
 *   worse than suggesting an odd one, so the balance is the ceiling. It is
 *   also what makes the final instalment settle the reservation exactly.
 * - **`monthsRemaining = 0` means "all of it".** Past the last month-start
 *   there is no month left to spread the balance over; the deadline is the
 *   deadline.
 *
 * Purely motivational: the system never rejects a payment for being smaller
 * than this, and never stores the number. The only enforced amount is the
 * minimum deposit at reservation time.
 *
 * The division is floating point, which is allowed here and only here: this
 * value is recomputed on every read and never reaches a stored column. A
 * quotient that is exactly a whole number of pesos is representable, so IEEE
 * returns it exactly and the rounding up cannot gain a spurious peso.
 */
export function suggestedMonthly(balanceCents: Cents, monthsRemaining: number): Cents {
  if (balanceCents <= 0) return 0;
  const months = Math.max(monthsRemaining, 1);
  return Math.min(balanceCents, roundUpToPeso(balanceCents / months));
}
