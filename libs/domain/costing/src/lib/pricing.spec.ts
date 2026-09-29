import { describe, expect, it } from 'vitest';
import { calculatePricing } from './pricing';

const lines = [
  { quantity: 1, unitAmountCents: 500_000 }, // bus: $5,000.00
  { quantity: 20, unitAmountCents: 120_000 }, // lodging per person: $1,200.00
];
// budgetTotal = 500,000 + 2,400,000 = 2,900,000 cents = $29,000.00

describe('calculatePricing', () => {
  it('sums the budget lines respecting quantity', () => {
    const result = calculatePricing({ lines, marginMode: 'FIXED_TOTAL', marginValue: 0, totalCapacity: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.budgetTotalCents).toBe(2_900_000);
  });

  it('applies a percentage margin expressed in basis points', () => {
    // 20.00 % over $29,000.00 = $34,800.00 -> / 20 seats = $1,740.00
    const result = calculatePricing({ lines, marginMode: 'PERCENTAGE', marginValue: 2000, totalCapacity: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalWithMarginCents).toBe(3_480_000);
    expect(result.value.pricePerSeatCents).toBe(174_000);
  });

  it('applies a fixed total margin in cents', () => {
    // $6,000.00 added to the whole budget: $35,000.00 / 20 seats = $1,750.00
    const result = calculatePricing({ lines, marginMode: 'FIXED_TOTAL', marginValue: 600_000, totalCapacity: 20 });
    expect(result.ok && result.value.totalWithMarginCents).toBe(3_500_000);
    expect(result.ok && result.value.pricePerSeatCents).toBe(175_000);
  });

  it('applies a fixed per-seat margin in cents, distinct from the same-looking fixed-total case', () => {
    // $250.00 per seat x 20 seats = $5,000.00 added -> $34,000.00 total, not the
    // $35,000.00 from the fixed-total case above: same shape of input, different
    // mode, deliberately a different number so the two modes cannot be confused.
    const result = calculatePricing({ lines, marginMode: 'FIXED_PER_SEAT', marginValue: 25_000, totalCapacity: 20 });
    expect(result.ok && result.value.totalWithMarginCents).toBe(3_400_000);
    expect(result.ok && result.value.pricePerSeatCents).toBe(170_000);
  });

  it('rounds the per-seat price up to the next whole peso', () => {
    // $1,000.00 split 3 ways = $333.3333... -> $334.00
    const result = calculatePricing({
      lines: [{ quantity: 1, unitAmountCents: 100_000 }],
      marginMode: 'FIXED_TOTAL',
      marginValue: 0,
      totalCapacity: 3,
    });
    expect(result.ok && result.value.pricePerSeatCents).toBe(33_400);
  });

  it('handles an empty budget as zero', () => {
    const result = calculatePricing({ lines: [], marginMode: 'PERCENTAGE', marginValue: 2000, totalCapacity: 10 });
    expect(result.ok && result.value.budgetTotalCents).toBe(0);
    expect(result.ok && result.value.pricePerSeatCents).toBe(0);
  });

  it('rejects a capacity of zero instead of dividing by it', () => {
    const result = calculatePricing({ lines, marginMode: 'PERCENTAGE', marginValue: 2000, totalCapacity: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_CAPACITY');
  });

  it('rejects a negative margin', () => {
    const result = calculatePricing({ lines, marginMode: 'PERCENTAGE', marginValue: -500, totalCapacity: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a line with a non-positive quantity, even when called directly with no upstream validation', () => {
    const result = calculatePricing({
      lines: [{ quantity: 0, unitAmountCents: 500_000 }],
      marginMode: 'FIXED_TOTAL',
      marginValue: 0,
      totalCapacity: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a line with a non-positive unit amount, even when called directly with no upstream validation', () => {
    const result = calculatePricing({
      lines: [{ quantity: 1, unitAmountCents: 0 }],
      marginMode: 'FIXED_TOTAL',
      marginValue: 0,
      totalCapacity: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});
