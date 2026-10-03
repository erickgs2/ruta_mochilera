import { describe, expect, it } from 'vitest';
import { formatMoney, roundUpToPeso } from './money';

describe('roundUpToPeso', () => {
  it('leaves exact pesos untouched', () => {
    expect(roundUpToPeso(12500)).toBe(12500);
  });

  it('rounds any fraction of a peso upwards', () => {
    expect(roundUpToPeso(12501)).toBe(12600);
    expect(roundUpToPeso(12599)).toBe(12600);
  });

  it('handles zero', () => {
    expect(roundUpToPeso(0)).toBe(0);
  });
});

describe('roundUpToPeso with negative input', () => {
  it('rounds away from zero so a refund is never understated', () => {
    expect(roundUpToPeso(-150)).toBe(-200);
    expect(roundUpToPeso(-100)).toBe(-100);
    expect(roundUpToPeso(-1)).toBe(-100);
  });
});

describe('formatMoney', () => {
  it('formats Spanish amounts with the MXN suffix', () => {
    expect(formatMoney(1250000, 'es')).toBe('$12,500.00 MXN');
  });

  it('formats English amounts with the MXN suffix', () => {
    expect(formatMoney(1250000, 'en')).toBe('$12,500.00 MXN');
  });

  it('formats cents that are not whole pesos', () => {
    expect(formatMoney(1250050, 'es')).toBe('$12,500.50 MXN');
  });
});
