import { fail, ok, roundUpToPeso, type Result } from '@rm/shared-utils';

export type MarginMode = 'PERCENTAGE' | 'FIXED_TOTAL' | 'FIXED_PER_SEAT';

export interface BudgetLine {
  quantity: number;
  unitAmountCents: number;
}

export interface PricingInput {
  lines: BudgetLine[];
  marginMode: MarginMode;
  /**
   * `marginValue` is always an integer -- money never touches floating point --
   * but the unit it counts changes with `marginMode`. This is the single most
   * important fact in this file: the same number means three different prices
   * depending on the mode next to it.
   *
   *   marginMode        unit of marginValue          example
   *   ----------------  ---------------------------  -----------------------
   *   PERCENTAGE        basis points (1/100 of 1%)    1500 = 15.00 %
   *   FIXED_TOTAL       cents added to the budget     600000 = $6,000.00 MXN
   *   FIXED_PER_SEAT     cents added per seat          30000 = $300.00 MXN
   *
   * Never move a raw `marginValue` between modes without converting it first.
   */
  marginValue: number;
  totalCapacity: number;
}

export interface PricingResult {
  budgetTotalCents: number;
  totalWithMarginCents: number;
  pricePerSeatCents: number;
}

/** Basis points per 100%: 10000 bp = 100.00%. See `PricingInput.marginValue`. */
const BASIS_POINTS = 10_000;

/**
 * Applies `marginMode`'s margin to `budgetTotalCents`, producing the total the
 * agency wants to collect before splitting it across seats.
 *
 * Written as a `switch` with an explicit exhaustiveness check (the `default`
 * branch below) rather than an `if`/`else if` chain, so that adding a fourth
 * `MarginMode` without touching this function is a compile error, not a
 * silent no-op.
 */
function applyMargin(
  budgetTotalCents: number,
  marginMode: MarginMode,
  marginValue: number,
  totalCapacity: number
): number {
  switch (marginMode) {
    case 'PERCENTAGE':
      return Math.round((budgetTotalCents * (BASIS_POINTS + marginValue)) / BASIS_POINTS);
    case 'FIXED_TOTAL':
      return budgetTotalCents + marginValue;
    case 'FIXED_PER_SEAT':
      return budgetTotalCents + marginValue * totalCapacity;
    default: {
      const exhaustive: never = marginMode;
      throw new Error(`Unhandled margin mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Computes the trip's budget total, the total after margin, and the resulting
 * price per seat. Pure and side-effect free: nothing in this file touches a
 * database. `budget-service.ts` is the only caller that persists anything --
 * see `computeCosting` and `persistCosting` there.
 */
export function calculatePricing(input: PricingInput): Result<PricingResult> {
  if (input.totalCapacity <= 0) return fail('INVALID_CAPACITY', { field: 'totalCapacity' });
  if (input.marginValue < 0) return fail('VALIDATION_FAILED', { field: 'marginValue' });

  // Enforced here, not just upstream: this function is exported from the
  // package's public API, so a caller reaching it directly -- bypassing
  // `budget-service.ts`'s own `validateItem` -- must still get a clear error
  // at the source instead of a silently wrong (or, via the guard below,
  // rejected-too-late) total. A free or negative-quantity line is not a line.
  for (const line of input.lines) {
    if (line.quantity <= 0) return fail('VALIDATION_FAILED', { field: 'quantity' });
    if (line.unitAmountCents <= 0) return fail('VALIDATION_FAILED', { field: 'unitAmountCents' });
  }

  const budgetTotalCents = input.lines.reduce(
    (total, line) => total + line.quantity * line.unitAmountCents,
    0
  );

  const totalWithMarginCents = applyMargin(
    budgetTotalCents,
    input.marginMode,
    input.marginValue,
    input.totalCapacity
  );

  // A non-negative margin applied to a non-negative budget (every line above
  // is now checked strictly positive) can never produce a negative total --
  // but `roundUpToPeso` rounds a negative amount *toward* zero, not away from
  // it, which would undercharge if this were ever negative. Kept as an
  // explicit guard rather than an assumption, in case a future margin mode or
  // a change to the checks above breaks that invariant.
  if (totalWithMarginCents < 0) {
    return fail('VALIDATION_FAILED', { field: 'totalWithMarginCents' });
  }

  // Rounded up to the next whole peso: the agency must never sell a seat
  // below its own cost because of a rounding remainder.
  const pricePerSeatCents = roundUpToPeso(totalWithMarginCents / input.totalCapacity);

  return ok({ budgetTotalCents, totalWithMarginCents, pricePerSeatCents });
}
