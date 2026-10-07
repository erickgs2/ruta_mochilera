import type { DbTransactionClient } from '@rm/db';
import { organizationTimeZone } from '@rm/domain-settings';
import { DateTime } from 'luxon';

const DEFAULT_RECEIPT_PREFIX = 'RM';
const RECEIPT_PREFIX_SETTING_KEY = 'receipt.prefix';

async function receiptPrefix(tx: DbTransactionClient): Promise<string> {
  const setting = await tx.systemSetting.findUnique({ where: { key: RECEIPT_PREFIX_SETTING_KEY } });
  return typeof setting?.value === 'string' && setting.value.trim() !== ''
    ? setting.value.trim()
    : DEFAULT_RECEIPT_PREFIX;
}

/**
 * Takes the next receipt number for the year a payment was made in:
 * `{receipt.prefix}-{year}-{000001}`.
 *
 * Must run inside the transaction that leaves the payment `SUCCEEDED`, and
 * only once that transition is certain: the counter row stays locked until
 * the caller commits, so a second payment waits here instead of reading the
 * same number, and a transaction that rolls back takes its increment with it
 * -- no gaps and no duplicates. A PostgreSQL sequence would leave a gap on
 * every rollback, which is why this is a row and not a sequence.
 *
 * The year is the calendar year of `paidAt` in the organization's timezone:
 * a payment at 23:30 on 31 December in Mexico City belongs to the year that
 * is ending, even though it is already 1 January in UTC.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` creates the year's row the first time;
 * a concurrent first payment of the year blocks on that insert and then finds
 * the row. The `UPDATE ... RETURNING` both locks the row and increments it,
 * which is the `SELECT ... FOR UPDATE` plus write in one statement.
 */
export async function assignReceiptNumber(tx: DbTransactionClient, paidAt: Date): Promise<string> {
  const timeZone = await organizationTimeZone(tx);
  const year = DateTime.fromJSDate(paidAt, { zone: timeZone }).year;
  const prefix = await receiptPrefix(tx);

  await tx.$executeRaw`
    INSERT INTO receipt_counters (year, last_number, updated_at)
    VALUES (${year}, 0, now())
    ON CONFLICT (year) DO NOTHING
  `;
  const [counter] = await tx.$queryRaw<{ last_number: number }[]>`
    UPDATE receipt_counters
    SET last_number = last_number + 1, updated_at = now()
    WHERE year = ${year}
    RETURNING last_number
  `;

  return `${prefix}-${year}-${String(counter.last_number).padStart(6, '0')}`;
}
