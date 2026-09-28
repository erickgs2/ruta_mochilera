/** A monetary amount in MXN cents. Never use floating point for money. */
export type Cents = number;

const CENTS_PER_PESO = 100;

/** Rounds an amount up to the next whole peso. */
export function roundUpToPeso(cents: Cents): Cents {
  return Math.ceil(cents / CENTS_PER_PESO) * CENTS_PER_PESO;
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
