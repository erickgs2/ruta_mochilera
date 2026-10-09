import type { Db, DbTransactionClient } from '@rm/db';

export interface PaymentSettings {
  minInstallmentCents: number;
  oxxoActiveVoucherDays: number;
  speiActiveLifetimeHours: number;
  speiEnabled: boolean;
  cardIntentStaleHours: number;
}

/** The owner's decisions D1, D3, D5, D6 and D9 (abono libre spec §15). Also the fallback for an unseeded database. */
export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  minInstallmentCents: 30_000,
  oxxoActiveVoucherDays: 3,
  speiActiveLifetimeHours: 72,
  speiEnabled: false,
  cardIntentStaleHours: 24,
};

const KEYS: Record<keyof PaymentSettings, string> = {
  minInstallmentCents: 'payments.min_installment_cents',
  oxxoActiveVoucherDays: 'payments.oxxo_active_voucher_days',
  speiActiveLifetimeHours: 'payments.spei_active_lifetime_hours',
  speiEnabled: 'payments.spei_enabled',
  cardIntentStaleHours: 'payments.card_intent_stale_hours',
};

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/**
 * The adjustable payment rules, read on every use (no cache: staff change them
 * without a deploy). A missing or malformed row keeps its default, so a typo in
 * the admin can never turn into a minimum of zero.
 */
export async function readPaymentSettings(db: Db | DbTransactionClient): Promise<PaymentSettings> {
  const rows = await db.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const stored = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const int = (field: Exclude<keyof PaymentSettings, 'speiEnabled'>) => {
    const value = stored.get(KEYS[field]);
    return isPositiveInt(value) ? value : DEFAULT_PAYMENT_SETTINGS[field];
  };
  const flag = stored.get(KEYS.speiEnabled);
  return {
    minInstallmentCents: int('minInstallmentCents'),
    oxxoActiveVoucherDays: int('oxxoActiveVoucherDays'),
    speiActiveLifetimeHours: int('speiActiveLifetimeHours'),
    speiEnabled: typeof flag === 'boolean' ? flag : DEFAULT_PAYMENT_SETTINGS.speiEnabled,
    cardIntentStaleHours: int('cardIntentStaleHours'),
  };
}
