import { describe, expect, it } from 'vitest';
import { createPaymentIntentRequestSchema } from './payments';

describe('createPaymentIntentRequestSchema', () => {
  it('keeps FULL and DEPOSIT exactly as the current app sends them', () => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'FULL', method: 'CARD' }).success).toBe(true);
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'DEPOSIT', method: 'OXXO' }).success).toBe(true);
  });

  it('takes an amount only with AMOUNT', () => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD', amountCents: 30_000 }).success).toBe(true);
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD' }).success).toBe(false);
  });

  // A FULL that carried an amount would be a second way to say how much;
  // there must be exactly one.
  it('drops an amount sent with FULL or DEPOSIT', () => {
    const parsed = createPaymentIntentRequestSchema.parse({ intent: 'FULL', method: 'CARD', amountCents: 1 });
    expect('amountCents' in parsed).toBe(false);
  });

  it.each([0, -100, 12.5, '30000'])('refuses an amount of %j', (amountCents) => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD', amountCents }).success).toBe(false);
  });
});
