import { describe, expect, it } from 'vitest';
import { suggestedMonthly } from './instalment';

describe('suggestedMonthly', () => {
  it('divides the balance across the remaining month-starts, rounding up to the peso', () => {
    expect(suggestedMonthly(1_000_000, 4)).toBe(250_000);
    expect(suggestedMonthly(10_000, 3)).toBe(3_400); // 100.00 / 3 = 33.33 -> 34.00
    expect(suggestedMonthly(100_000, 3)).toBe(33_400); // 1,000.00 / 3 = 333.33 -> 334.00
  });

  it('returns the whole balance when no month-start remains', () => {
    expect(suggestedMonthly(500_000, 0)).toBe(500_000);
  });

  it('returns zero for a settled reservation', () => {
    expect(suggestedMonthly(0, 5)).toBe(0);
  });

  // Rounding up is what makes the instalments add up to the total; rounding
  // down leaves the customer short by up to one peso per month.
  it('rounds up so the instalments cover the balance', () => {
    const balanceCents = 10_000;
    const months = 3;
    expect(suggestedMonthly(balanceCents, months) * months).toBeGreaterThanOrEqual(balanceCents);
  });

  // The suggestion must never exceed what `recordPayment` will accept, or the
  // app would print an amount the API answers with PAYMENT_EXCEEDS_BALANCE.
  it('never suggests more than the balance itself', () => {
    expect(suggestedMonthly(10_050, 1)).toBe(10_050);
    expect(suggestedMonthly(50, 3)).toBe(50);
  });

  it('settles the balance exactly on the last instalment', () => {
    // 100.50 over three months: 34.00, 34.00 and then whatever is left.
    let balance = 10_050;
    const paid: number[] = [];
    for (let months = 3; months > 0; months--) {
      const instalment = suggestedMonthly(balance, months);
      paid.push(instalment);
      balance -= instalment;
    }
    expect(paid).toEqual([3_400, 3_400, 3_250]);
    expect(balance).toBe(0);
  });

  it('is a whole number of pesos', () => {
    expect(suggestedMonthly(123_457, 7) % 100).toBe(0);
  });

  it('treats a negative balance as settled', () => {
    expect(suggestedMonthly(-1, 3)).toBe(0);
  });
});
