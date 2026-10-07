import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, Locale, ReservationStatus } from '@rm/db';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { applyPriceChange, previewPriceChange, type CreditFromPriceDecrease } from './price-change';

const db = withTestDb();

let staffId: string;
let queue: PgBoss;
let sequence = 0;

/** Writes the credit the way `@rm/domain-payments` would, without importing it. */
const creditHook: CreditFromPriceDecrease = async (tx, input) => {
  await tx.customerCreditEntry.create({
    data: { customerId: input.customerId, reservationId: input.reservationId, amountCents: input.amountCents, kind: 'PRICE_DECREASE', createdById: input.actorId },
  });
};

async function seedTrip(client: Db, priceCents: number) {
  sequence += 1;
  return client.trip.create({
    data: {
      slug: `price-${sequence}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: priceCents,
      createdById: staffId,
      translations: {
        create: [
          { locale: 'es', name: 'Oaxaca', description: 'd', itinerary: 'i', includes: 'i', excludes: 'e' },
          { locale: 'en', name: 'Oaxaca (EN)', description: 'd', itinerary: 'i', includes: 'i', excludes: 'e' },
        ],
      },
    },
  });
}

async function seedReservation(
  client: Db,
  tripId: string,
  options: { totalPriceCents: number; paidCents?: number; status?: ReservationStatus; locale?: Locale }
) {
  sequence += 1;
  const customer = await client.user.create({
    data: {
      email: `c${sequence}@example.com`,
      type: 'CUSTOMER',
      locale: options.locale ?? 'es',
      emailVerifiedAt: new Date(),
      customerProfile: { create: { fullName: `Cliente ${sequence}`, phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'BRANCH' } },
    },
  });
  const status = options.status ?? 'ACTIVE';
  return client.reservation.create({
    data: {
      code: `RM-P${sequence}`,
      tripId,
      customerId: customer.id,
      status,
      holdExpiresAt: status === 'HELD' ? new Date(Date.now() + 3_600_000) : null,
      totalPriceCents: options.totalPriceCents,
      minimumDepositCents: 100_000,
      paidCents: options.paidCents ?? 0,
      paymentDeadline: new Date('2027-11-01'),
      source: 'BRANCH',
    },
  });
}

beforeAll(async () => {
  await prepareTestDb();
  queue = await withTestQueue();
});

beforeEach(async () => {
  await resetDatabase(db);
  await resetTestQueue();
  const staff = await db.user.create({ data: { email: 'admin@agency.test', type: 'STAFF' } });
  staffId = staff.id;
});

afterAll(async () => {
  await closeTestQueue();
  await closeTestDb();
});

describe('previewPriceChange', () => {
  it('lists only live reservations whose total differs, with the effect on each', async () => {
    const trip = await seedTrip(db, 400_000);
    const up = await seedReservation(db, trip.id, { totalPriceCents: 350_000, paidCents: 100_000 });
    const down = await seedReservation(db, trip.id, { totalPriceCents: 500_000, paidCents: 450_000 });
    await seedReservation(db, trip.id, { totalPriceCents: 400_000 });
    await seedReservation(db, trip.id, { totalPriceCents: 300_000, status: 'CANCELLED' });

    const preview = await previewPriceChange(db, trip.id);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const byId = Object.fromEntries(preview.value.reservations.map((row) => [row.reservationId, row]));
    expect(Object.keys(byId).sort()).toEqual([up.id, down.id].sort());
    expect(byId[up.id]).toMatchObject({ previousTotalCents: 350_000, newTotalCents: 400_000, paidCents: 100_000, newBalanceCents: 300_000, creditCents: 0 });
    expect(byId[down.id]).toMatchObject({ previousTotalCents: 500_000, newTotalCents: 400_000, paidCents: 450_000, newBalanceCents: 0, creditCents: 50_000 });
  });

  it('answers NO_PRICE_CHANGE when every reservation already has the current price', async () => {
    const trip = await seedTrip(db, 400_000);
    await seedReservation(db, trip.id, { totalPriceCents: 400_000 });

    expect(await previewPriceChange(db, trip.id)).toMatchObject({ ok: false, error: { code: 'NO_PRICE_CHANGE' } });
  });
});

describe('applyPriceChange', () => {
  it('requires the Spanish notice', async () => {
    const trip = await seedTrip(db, 400_000);
    await seedReservation(db, trip.id, { totalPriceCents: 350_000 });

    const result = await applyPriceChange(db, queue, { tripId: trip.id, noticeEs: '  ', actorId: staffId }, creditHook);

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'noticeEs' } } });
  });

  it('raises the total and the balance, keeps the status, and records the change', async () => {
    const trip = await seedTrip(db, 400_000);
    const reservation = await seedReservation(db, trip.id, { totalPriceCents: 350_000, paidCents: 100_000, status: 'ACTIVE' });

    await applyPriceChange(db, queue, { tripId: trip.id, noticeEs: 'Subió el hospedaje.', actorId: staffId }, creditHook);

    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      totalPriceCents: 400_000,
      paidCents: 100_000,
      status: 'ACTIVE',
      minimumDepositCents: 100_000,
    });
    expect(await db.reservationPriceChange.findMany()).toMatchObject([
      { reservationId: reservation.id, previousTotalCents: 350_000, newTotalCents: 400_000, noticeEs: 'Subió el hospedaje.', changedById: staffId },
    ]);
    expect(await db.customerCreditEntry.count()).toBe(0);
  });

  it('moves what was paid above a lower total to the customer credit and leaves the balance at zero', async () => {
    const trip = await seedTrip(db, 400_000);
    const reservation = await seedReservation(db, trip.id, { totalPriceCents: 500_000, paidCents: 450_000 });

    await applyPriceChange(db, queue, { tripId: trip.id, noticeEs: 'Bajó el transporte.', actorId: staffId }, creditHook);

    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after).toMatchObject({ totalPriceCents: 400_000, paidCents: 400_000 });
    expect(await db.customerCreditEntry.findMany()).toMatchObject([
      { customerId: reservation.customerId, reservationId: reservation.id, amountCents: 50_000, kind: 'PRICE_DECREASE' },
    ]);
  });

  it('tells each customer in their language, with the English notice only when written', async () => {
    const trip = await seedTrip(db, 400_000);
    const spanish = await seedReservation(db, trip.id, { totalPriceCents: 500_000, paidCents: 450_000, locale: 'es' });
    const english = await seedReservation(db, trip.id, { totalPriceCents: 350_000, locale: 'en' });

    await applyPriceChange(
      db,
      queue,
      { tripId: trip.id, noticeEs: 'Aviso en español.', noticeEn: 'Notice in English.', actorId: staffId },
      creditHook
    );

    const es = await db.notificationDelivery.findFirstOrThrow({ where: { userId: spanish.customerId, eventType: 'PRICE_CHANGED', channel: 'INBOX' } });
    const en = await db.notificationDelivery.findFirstOrThrow({ where: { userId: english.customerId, eventType: 'PRICE_CHANGED', channel: 'INBOX' } });
    expect(es.renderedBody).toContain('Aviso en español.');
    expect(es.renderedBody).toContain('$5,000.00 MXN');
    expect(es.renderedBody).toContain('saldo a favor');
    expect(en.renderedBody).toContain('Notice in English.');
    expect(en.renderedTitle).toContain('Oaxaca (EN)');
    expect(en.renderedBody).not.toContain('credit');
    expect(await db.notificationDelivery.count({ where: { eventType: 'PRICE_CHANGED' } })).toBe(4);
  });

  it('falls back to the Spanish notice for an English customer when none was written', async () => {
    const trip = await seedTrip(db, 400_000);
    const english = await seedReservation(db, trip.id, { totalPriceCents: 350_000, locale: 'en' });

    await applyPriceChange(db, queue, { tripId: trip.id, noticeEs: 'Sólo en español.', actorId: staffId }, creditHook);

    const delivery = await db.notificationDelivery.findFirstOrThrow({ where: { userId: english.customerId, channel: 'INBOX' } });
    expect(delivery.renderedBody).toContain('Sólo en español.');
  });

  it('rolls everything back when the credit cannot be written', async () => {
    const trip = await seedTrip(db, 400_000);
    const reservation = await seedReservation(db, trip.id, { totalPriceCents: 500_000, paidCents: 450_000 });

    await expect(
      applyPriceChange(db, queue, { tripId: trip.id, noticeEs: 'x', actorId: staffId }, async () => {
        throw new Error('ledger down');
      })
    ).rejects.toThrow('ledger down');

    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ totalPriceCents: 500_000, paidCents: 450_000 });
    expect(await db.reservationPriceChange.count()).toBe(0);
    expect(await db.notificationDelivery.count()).toBe(0);
  });

  it('answers NO_PRICE_CHANGE when there is nothing to update', async () => {
    const trip = await seedTrip(db, 400_000);

    expect(await applyPriceChange(db, queue, { tripId: trip.id, noticeEs: 'x', actorId: staffId }, creditHook)).toMatchObject({
      ok: false,
      error: { code: 'NO_PRICE_CHANGE' },
    });
  });
});
