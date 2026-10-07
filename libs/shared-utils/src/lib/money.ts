/** A monetary amount in MXN cents. Never use floating point for money. */
export type Cents = number;

const CENTS_PER_PESO = 100;

/**
 * Rounds an amount to the next whole peso, away from zero. For a positive
 * amount (a sale price) that means rounding up: the agency never sells for
 * a fraction of a peso less than the computed price. For a negative amount
 * (a refund) rounding toward zero would return *less* than owed, so negative
 * input rounds down instead -- the same "a peso over is fine, a peso under
 * is not" rule, applied on whichever side of zero the amount falls.
 */
export function roundUpToPeso(cents: Cents): Cents {
  const rounder = cents < 0 ? Math.floor : Math.ceil;
  return rounder(cents / CENTS_PER_PESO) * CENTS_PER_PESO;
}

/** Formats cents for display, e.g. "$12,500.00 MXN". */
export function formatMoney(cents: Cents, locale: 'es' | 'en'): string {
  const formatted = new Intl.NumberFormat(locale === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency: 'MXN',
    currencyDisplay: 'symbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / CENTS_PER_PESO);

  // Intl emits "MX$12,500.00" under some ICU builds; normalize to "$12,500.00 MXN".
  return `${formatted.replace(/^MX\$/, '$').replace(/\s?MXN$/, '')} MXN`;
}
