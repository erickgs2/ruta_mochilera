import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { DEFAULT_PAYMENT_SETTINGS, readPaymentSettings } from './payment-settings';

const db = withTestDb();

describe('readPaymentSettings', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb());

  it('falls back to the owner-approved defaults when the seed never ran', async () => {
    expect(await readPaymentSettings(db)).toEqual({
      minInstallmentCents: 30_000,
      oxxoActiveVoucherDays: 3,
      speiActiveLifetimeHours: 72,
      speiEnabled: false,
      cardIntentStaleHours: 24,
    });
    expect(DEFAULT_PAYMENT_SETTINGS.minInstallmentCents).toBe(30_000);
  });

  it('reads what staff stored', async () => {
    await db.systemSetting.createMany({
      data: [
        { key: 'payments.min_installment_cents', value: 50_000 },
        { key: 'payments.spei_enabled', value: true },
      ],
    });
    const settings = await readPaymentSettings(db);
    expect(settings.minInstallmentCents).toBe(50_000);
    expect(settings.speiEnabled).toBe(true);
    expect(settings.oxxoActiveVoucherDays).toBe(3);
  });

  // A typo in the admin (a string, a fraction, zero) must never become a
  // minimum of 0 or a voucher that expires today.
  it.each([
    ['payments.min_installment_cents', 'trescientos'],
    ['payments.min_installment_cents', 12.5],
    ['payments.oxxo_active_voucher_days', 0],
    ['payments.card_intent_stale_hours', -1],
    ['payments.spei_enabled', 'yes'],
  ])('ignores a malformed %s (%j) and keeps the default', async (key, value) => {
    await db.systemSetting.create({ data: { key, value } });
    expect(await readPaymentSettings(db)).toEqual(DEFAULT_PAYMENT_SETTINGS);
  });
});
