/**
 * Reads an amount in pesos as written in a spreadsheet -- «1500», «1500.1»,
 * «1,500.10», «$1,500.10» -- and returns exact cents, or null when it is not
 * an amount. Parsed as text, never through a float: «1500.10» is 150 010
 * cents, not 150 009.99…
 */
export function parsePesosToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/\s?MXN$/i, '').trim();
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const pesos = Number.parseInt((match[1] as string).replace(/,/g, ''), 10);
  const cents = Number.parseInt(((match[2] ?? '') + '00').slice(0, 2), 10);
  const total = pesos * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}
