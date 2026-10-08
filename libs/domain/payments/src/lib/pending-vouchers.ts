import type { Db, Payment, Prisma, PaymentMethod, Reservation } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { PaymentDto } from './payment-service';

/** The only methods whose pending payment is "money we are waiting for": a card intent that was opened and abandoned is noise. */
export const VOUCHER_METHODS = ['OXXO', 'SPEI'] as const satisfies readonly PaymentMethod[];
export type VoucherMethod = (typeof VOUCHER_METHODS)[number];

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** One pending voucher with what the counter needs to chase it. */
export interface StaffPaymentRowDto extends PaymentDto {
  reservationCode: string;
  reservationStatus: Reservation['status'];
  customerId: string;
  customerName: string;
  tripName: string;
  createdAt: Date;
}

export interface StaffPaymentPageDto {
  items: StaffPaymentRowDto[];
  nextCursor: string | null;
}

export interface ListPendingVouchersOptions {
  method?: VoucherMethod;
  limit?: number;
  cursor?: string;
}

interface Cursor {
  /** `voucher_expires_at` of the last row of the previous page, `null` when it had none. */
  voucherExpiresAt: string | null;
  recordedAt: string;
  id: string;
}

function encodeCursor(row: Pick<Payment, 'voucherExpiresAt' | 'recordedAt' | 'id'>): string {
  const payload: Cursor = {
    voucherExpiresAt: row.voucherExpiresAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An instant exactly as `encodeCursor` writes it (`Date#toISOString`), so a hand-made value is refused. */
function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function decodeCursor(cursor: string): Result<Cursor> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    const validExpiry = parsed.voucherExpiresAt === null || isIsoInstant(parsed.voucherExpiresAt);
    // The id reaches a uuid column: anything else would be a Prisma P2007 and a 500.
    if (!validExpiry || !isIsoInstant(parsed.recordedAt) || typeof parsed.id !== 'string' || !UUID_PATTERN.test(parsed.id)) {
      return fail('VALIDATION_FAILED', { field: 'cursor' });
    }
    return ok(parsed as Cursor);
  } catch {
    return fail('VALIDATION_FAILED', { field: 'cursor' });
  }
}

/**
 * The rows that sort after `cursor` in (voucher expiry asc, nulls last,
 * recorded at asc, id asc). Written out as an OR of prefixes because a nullable
 * column cannot take part in a plain tuple comparison.
 */
function afterCursor(cursor: Cursor): Prisma.PaymentWhereInput {
  const recordedAt = new Date(cursor.recordedAt);
  if (cursor.voucherExpiresAt === null) {
    return {
      voucherExpiresAt: null,
      OR: [{ recordedAt: { gt: recordedAt } }, { recordedAt, id: { gt: cursor.id } }],
    };
  }
  const expiresAt = new Date(cursor.voucherExpiresAt);
  return {
    OR: [
      { voucherExpiresAt: { gt: expiresAt } },
      { voucherExpiresAt: null },
      { voucherExpiresAt: expiresAt, recordedAt: { gt: recordedAt } },
      { voucherExpiresAt: expiresAt, recordedAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * The OXXO and SPEI vouchers still waiting to be paid, across every
 * reservation, for the counter's work queue. Staff cannot confirm any of them:
 * a payment only exists when Stripe says so by webhook (`payments.md`), so this
 * is a list of money to chase, soonest-expiring first, vouchers without an
 * expiry (SPEI) last.
 *
 * Keyset pagination, because the sort key (the expiry) moves while someone
 * works the list; an offset would skip or repeat rows.
 */
export async function listPendingVouchers(db: Db, options: ListPendingVouchersOptions): Promise<Result<StaffPaymentPageDto>> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  let cursor: Cursor | undefined;
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded.ok) return decoded;
    cursor = decoded.value;
  }

  const rows = await db.payment.findMany({
    where: {
      status: 'PENDING',
      method: options.method ?? { in: [...VOUCHER_METHODS] },
      ...(cursor ? { AND: [afterCursor(cursor)] } : {}),
    },
    orderBy: [{ voucherExpiresAt: { sort: 'asc', nulls: 'last' } }, { recordedAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    include: {
      reservation: {
        select: {
          code: true,
          status: true,
          customerId: true,
          trip: { select: { slug: true, translations: { where: { locale: 'es' }, select: { name: true } } } },
          customer: { select: { fullName: true } },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return ok({
    items: page.map((row) => ({
      id: row.id,
      reservationId: row.reservationId,
      reservationCode: row.reservation.code,
      reservationStatus: row.reservation.status,
      customerId: row.reservation.customerId,
      customerName: row.reservation.customer.fullName,
      tripName: row.reservation.trip.translations[0]?.name ?? row.reservation.trip.slug,
      amountCents: row.amountCents,
      method: row.method,
      status: row.status,
      provider: row.provider,
      paidAt: row.paidAt,
      recordedAt: row.recordedAt,
      createdAt: row.createdAt,
      providerVoucherUrl: row.providerVoucherUrl,
      voucherExpiresAt: row.voucherExpiresAt,
      receiptNumber: row.receiptNumber,
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  });
}
