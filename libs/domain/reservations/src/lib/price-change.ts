import type { Db, DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { notifyCustomer, type NotificationQueue } from '@rm/domain-notifications';
import { fail, formatMoney, ok, type Result } from '@rm/shared-utils';
import { lockTripForCapacity } from './capacity';

/**
 * Bringing a trip's current price to its existing reservations (Phase 2B,
 * business rule 5.6). Editing the price in costing only affects new
 * reservations -- amounts are frozen at creation. This is the explicit,
 * audited operation that moves the live ones, with a mandatory notice.
 */

/**
 * Turns the part of a reservation's payments above its new, lower total into
 * the customer's credit (`PRICE_DECREASE`), inside the price change's own
 * transaction. Implemented by `@rm/domain-payments`'
 * `creditFromPriceDecrease` and typed here structurally: the two domains do
 * not import each other.
 */
export type CreditFromPriceDecrease = (
  tx: DbTransactionClient,
  input: { customerId: string; reservationId: string; amountCents: number; actorId: string }
) => Promise<void>;

export interface PriceChangeRowDto {
  reservationId: string;
  code: string;
  customerName: string;
  status: 'HELD' | 'ACTIVE';
  previousTotalCents: number;
  newTotalCents: number;
  paidCents: number;
  /** What the customer owes after the change. */
  newBalanceCents: number;
  /** What becomes credit because they had already paid more than the new total. */
  creditCents: number;
}

export interface PriceChangePreviewDto {
  tripId: string;
  priceCents: number;
  reservations: PriceChangeRowDto[];
}

export interface ApplyPriceChangeInput {
  tripId: string;
  /** Mandatory: every affected customer reads it. */
  noticeEs: string;
  /** Optional: customers whose language is English get it when present. */
  noticeEn?: string;
  actorId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Client = Db | DbTransactionClient;

async function affected(client: Client, tripId: string, priceCents: number) {
  return client.reservation.findMany({
    where: { tripId, status: { in: ['HELD', 'ACTIVE'] }, totalPriceCents: { not: priceCents } },
    include: { customer: { select: { fullName: true, user: { select: { locale: true } } } } },
    orderBy: { id: 'asc' },
  });
}

function row(
  reservation: Awaited<ReturnType<typeof affected>>[number],
  priceCents: number
): PriceChangeRowDto {
  const creditCents = Math.max(0, reservation.paidCents - priceCents);
  const paidAfter = reservation.paidCents - creditCents;
  return {
    reservationId: reservation.id,
    code: reservation.code,
    customerName: reservation.customer.fullName,
    status: reservation.status as 'HELD' | 'ACTIVE',
    previousTotalCents: reservation.totalPriceCents,
    newTotalCents: priceCents,
    paidCents: reservation.paidCents,
    newBalanceCents: Math.max(0, priceCents - paidAfter),
    creditCents,
  };
}

/**
 * What applying the trip's current price would do: only `HELD`/`ACTIVE`
 * reservations whose frozen total differs, each with its previous total, new
 * total, what was paid and the effect. None → `NO_PRICE_CHANGE`.
 */
export async function previewPriceChange(db: Db, tripId: string): Promise<Result<PriceChangePreviewDto>> {
  if (!UUID_PATTERN.test(tripId)) return fail('NOT_FOUND');
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true, pricePerSeatCents: true } });
  if (!trip) return fail('NOT_FOUND');

  const reservations = await affected(db, tripId, trip.pricePerSeatCents);
  if (reservations.length === 0) return fail('NO_PRICE_CHANGE');
  return ok({
    tripId,
    priceCents: trip.pricePerSeatCents,
    reservations: reservations.map((reservation) => row(reservation, trip.pricePerSeatCents)),
  });
}

/**
 * Applies the trip's current price to every affected reservation, in **one
 * transaction**, under the trip's lock and each reservation's: a payment
 * landing at the same moment is applied entirely before or entirely after,
 * never in between. For each reservation:
 *
 * 1. A `ReservationPriceChange` row: previous total, new total, the notice.
 * 2. `total_price_cents` takes the current price. The status does not move
 *    (an `ACTIVE` reservation stays `ACTIVE` even if it now owes more) and
 *    the frozen minimum deposit does not change either.
 * 3. When `paid_cents` exceeds the new total, the difference **leaves the
 *    reservation and becomes the customer's credit**: `paid_cents` goes down
 *    by it and a `PRICE_DECREASE` entry is written (injected hook). That is
 *    what keeps a later price increase or cancellation from handing out the
 *    same money twice; the nightly reconciliation subtracts these entries.
 * 4. `PRICE_CHANGED` to the customer: the staff notice in their language
 *    (English when written, Spanish otherwise) plus their own numbers.
 */
export async function applyPriceChange(
  db: Db,
  queue: NotificationQueue,
  input: ApplyPriceChangeInput,
  creditFromPriceDecrease: CreditFromPriceDecrease
): Promise<Result<PriceChangePreviewDto>> {
  const noticeEs = input.noticeEs.trim();
  const noticeEn = input.noticeEn?.trim() || undefined;
  if (noticeEs === '') return fail('VALIDATION_FAILED', { field: 'noticeEs' });
  if (!UUID_PATTERN.test(input.tripId)) return fail('NOT_FOUND');

  return db.$transaction(async (tx: DbTransactionClient): Promise<Result<PriceChangePreviewDto>> => {
    await lockTripForCapacity(tx, input.tripId);
    const trip = await tx.trip.findUnique({
      where: { id: input.tripId },
      select: { id: true, slug: true, pricePerSeatCents: true, translations: { select: { locale: true, name: true } } },
    });
    if (!trip) return fail('NOT_FOUND');
    const priceCents = trip.pricePerSeatCents;

    // Reservation rows locked in id order -- the order every other writer
    // that takes several of them would use -- then re-read under the lock.
    const candidates = await affected(tx, input.tripId, priceCents);
    if (candidates.length === 0) return fail('NO_PRICE_CHANGE');
    for (const candidate of candidates) {
      await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    }
    const reservations = await affected(tx, input.tripId, priceCents);
    if (reservations.length === 0) return fail('NO_PRICE_CHANGE');

    const rows: PriceChangeRowDto[] = [];
    for (const reservation of reservations) {
      const change = row(reservation, priceCents);
      rows.push(change);

      await tx.reservationPriceChange.create({
        data: {
          reservationId: reservation.id,
          previousTotalCents: change.previousTotalCents,
          newTotalCents: change.newTotalCents,
          noticeEs,
          noticeEn: noticeEn ?? null,
          changedById: input.actorId,
        },
      });
      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          totalPriceCents: priceCents,
          ...(change.creditCents > 0 ? { paidCents: { decrement: change.creditCents } } : {}),
        },
      });
      if (change.creditCents > 0) {
        await creditFromPriceDecrease(tx, {
          customerId: reservation.customerId,
          reservationId: reservation.id,
          amountCents: change.creditCents,
          actorId: input.actorId,
        });
      }

      await recordAudit(tx, {
        actorUserId: input.actorId,
        action: 'reservation.price_changed',
        entityType: 'Reservation',
        entityId: reservation.id,
        before: { totalPriceCents: change.previousTotalCents, paidCents: change.paidCents },
        after: {
          totalPriceCents: change.newTotalCents,
          paidCents: change.paidCents - change.creditCents,
          creditCents: change.creditCents,
        },
      });

      const locale = reservation.customer.user.locale;
      const translation = trip.translations.find((candidate) => candidate.locale === locale) ?? trip.translations[0];
      await notifyCustomer(tx, queue, {
        customerId: reservation.customerId,
        reservationId: reservation.id,
        eventType: 'PRICE_CHANGED',
        params: {
          tripName: translation?.name ?? trip.slug,
          reservationCode: reservation.code,
          notice: locale === 'en' && noticeEn ? noticeEn : noticeEs,
          previousTotal: formatMoney(change.previousTotalCents, locale),
          newTotal: formatMoney(change.newTotalCents, locale),
          balance: formatMoney(change.newBalanceCents, locale),
          ...(change.creditCents > 0 ? { credit: formatMoney(change.creditCents, locale) } : {}),
        },
      });
    }

    return ok({ tripId: input.tripId, priceCents, reservations: rows });
  });
}
