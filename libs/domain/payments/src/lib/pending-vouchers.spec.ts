import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { PaymentMethod, PaymentStatus } from '@rm/db';
import { listPendingVouchers } from './pending-vouchers';
import { seedReservation, seedStaff } from './test-fixtures';

const db = withTestDb();

let staffId: string;

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  staffId = await seedStaff(db);
});

afterAll(async () => {
  await closeTestDb();
});

interface SeedPayment {
  method?: PaymentMethod;
  status?: PaymentStatus;
  voucherExpiresAt?: Date | null;
  recordedAt?: Date;
  amountCents?: number;
}

async function seedPayment(reservationId: string, overrides: SeedPayment = {}) {
  const method = overrides.method ?? 'OXXO';
  return db.payment.create({
    data: {
      reservationId,
      amountCents: overrides.amountCents ?? 100_000,
      method,
      status: overrides.status ?? 'PENDING',
      provider: method === 'CASH' ? 'MANUAL' : 'STRIPE',
      providerVoucherUrl: method === 'OXXO' ? 'https://pay.example/voucher' : null,
      voucherExpiresAt: overrides.voucherExpiresAt === undefined ? new Date('2027-06-02T00:00:00Z') : overrides.voucherExpiresAt,
      recordedAt: overrides.recordedAt ?? new Date('2027-06-01T10:00:00Z'),
    },
  });
}

describe('listPendingVouchers', () => {
  it('lists only PENDING OXXO and SPEI payments, never card intents or settled money', async () => {
    const reservation = await seedReservation(db, staffId);
    const oxxo = await seedPayment(reservation.id, { method: 'OXXO' });
    const spei = await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null });
    await seedPayment(reservation.id, { method: 'CARD' });
    await seedPayment(reservation.id, { method: 'OXXO', status: 'SUCCEEDED' });
    await seedPayment(reservation.id, { method: 'SPEI', status: 'EXPIRED' });
    await seedPayment(reservation.id, { method: 'CASH', status: 'PENDING' });

    const page = await listPendingVouchers(db, {});

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items.map((row) => row.id).sort()).toEqual([oxxo.id, spei.id].sort());
    expect(page.value.nextCursor).toBeNull();
  });

  it('carries what the counter needs to chase each voucher', async () => {
    const reservation = await seedReservation(db, staffId);
    const trip = await db.trip.findUniqueOrThrow({ where: { id: reservation.tripId } });
    await db.tripTranslation.create({
      data: { tripId: trip.id, locale: 'es', name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'a', excludes: 'b' },
    });
    const payment = await seedPayment(reservation.id, { amountCents: 123_400, voucherExpiresAt: new Date('2027-06-03T18:00:00Z') });

    const page = await listPendingVouchers(db, {});

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const customer = await db.customerProfile.findUniqueOrThrow({ where: { userId: reservation.customerId } });
    expect(page.value.items).toHaveLength(1);
    expect(page.value.items[0]).toEqual({
      id: payment.id,
      reservationId: reservation.id,
      reservationCode: reservation.code,
      reservationStatus: reservation.status,
      customerId: reservation.customerId,
      customerName: customer.fullName,
      tripName: 'Oaxaca Mágica',
      amountCents: 123_400,
      method: 'OXXO',
      status: 'PENDING',
      provider: 'STRIPE',
      paidAt: null,
      recordedAt: payment.recordedAt,
      createdAt: payment.createdAt,
      providerVoucherUrl: 'https://pay.example/voucher',
      voucherExpiresAt: new Date('2027-06-03T18:00:00Z'),
      receiptNumber: null,
    });
  });

  it("names the trip by its slug when it has no Spanish name", async () => {
    const reservation = await seedReservation(db, staffId);
    const trip = await db.trip.findUniqueOrThrow({ where: { id: reservation.tripId } });
    await seedPayment(reservation.id);

    const page = await listPendingVouchers(db, {});

    expect(page.ok && page.value.items[0]?.tripName).toBe(trip.slug);
  });

  it('orders by voucher expiry, soonest first, vouchers without one last, then by when they were recorded', async () => {
    const reservation = await seedReservation(db, staffId);
    const late = await seedPayment(reservation.id, { voucherExpiresAt: new Date('2027-06-05T00:00:00Z') });
    const noExpiryOld = await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null, recordedAt: new Date('2027-06-01T08:00:00Z') });
    const soon = await seedPayment(reservation.id, { voucherExpiresAt: new Date('2027-06-02T00:00:00Z') });
    const noExpiryNew = await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null, recordedAt: new Date('2027-06-01T09:00:00Z') });

    const page = await listPendingVouchers(db, {});

    expect(page.ok && page.value.items.map((row) => row.id)).toEqual([soon.id, late.id, noExpiryOld.id, noExpiryNew.id]);
  });

  it('pages with a keyset cursor across expiries, ties and null expiries, without skipping or repeating a row', async () => {
    const reservation = await seedReservation(db, staffId);
    const sameMoment = new Date('2027-06-02T00:00:00Z');
    const seeded = [
      await seedPayment(reservation.id, { voucherExpiresAt: sameMoment, recordedAt: new Date('2027-06-01T10:00:00Z') }),
      await seedPayment(reservation.id, { voucherExpiresAt: sameMoment, recordedAt: new Date('2027-06-01T10:00:00Z') }),
      await seedPayment(reservation.id, { voucherExpiresAt: sameMoment, recordedAt: new Date('2027-06-01T11:00:00Z') }),
      await seedPayment(reservation.id, { voucherExpiresAt: new Date('2027-06-09T00:00:00Z') }),
      await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null, recordedAt: new Date('2027-06-01T10:00:00Z') }),
      await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null, recordedAt: new Date('2027-06-01T10:00:00Z') }),
    ];

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listPendingVouchers(db, { limit: 2, cursor });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.value.items.map((row) => row.id));
      cursor = page.value.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seeded.length);
    expect(seen.sort()).toEqual(seeded.map((payment) => payment.id).sort());
  });

  it('breaks a tie on the same expiry and the same recorded-at by id, one row per page', async () => {
    const reservation = await seedReservation(db, staffId);
    const shared = { voucherExpiresAt: new Date('2027-06-02T00:00:00Z'), recordedAt: new Date('2027-06-01T10:00:00Z') };
    const seeded = [
      await seedPayment(reservation.id, shared),
      await seedPayment(reservation.id, shared),
      await seedPayment(reservation.id, shared),
    ];
    const expected = seeded.map((payment) => payment.id).sort();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listPendingVouchers(db, { limit: 1, cursor });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.value.items.map((row) => row.id));
      cursor = page.value.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it('narrows to one method', async () => {
    const reservation = await seedReservation(db, staffId);
    await seedPayment(reservation.id, { method: 'OXXO' });
    const spei = await seedPayment(reservation.id, { method: 'SPEI', voucherExpiresAt: null });

    const page = await listPendingVouchers(db, { method: 'SPEI' });

    expect(page.ok && page.value.items.map((row) => row.id)).toEqual([spei.id]);
  });

  it('answers an empty page when nothing is pending', async () => {
    const page = await listPendingVouchers(db, {});
    expect(page).toEqual({ ok: true, value: { items: [], nextCursor: null } });
  });

  const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const valid = { voucherExpiresAt: '2027-06-02T00:00:00.000Z', recordedAt: '2027-06-01T10:00:00.000Z', id: '8c1d0b7e-3f1a-4b8e-9a52-6f4b1d2c7a10' };

  it.each([
    ['an id that is not a UUID', { ...valid, id: 'not-a-uuid' }],
    ['a missing id', { voucherExpiresAt: valid.voucherExpiresAt, recordedAt: valid.recordedAt }],
    ['a numeric id', { ...valid, id: 7 }],
    ['a recordedAt that is not a date', { ...valid, recordedAt: 'yesterday' }],
    ['a missing recordedAt', { voucherExpiresAt: valid.voucherExpiresAt, id: valid.id }],
    ['a null recordedAt', { ...valid, recordedAt: null }],
    ['a voucherExpiresAt that is not a date', { ...valid, voucherExpiresAt: 'soon' }],
    ['a missing voucherExpiresAt', { recordedAt: valid.recordedAt, id: valid.id }],
    ['a JSON null', null],
  ])('answers VALIDATION_FAILED field=cursor, not a database error, for a forged cursor with %s', async (_label, payload) => {
    const page = await listPendingVouchers(db, { cursor: forge(payload) });
    expect(page).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'cursor' } } });
  });

  it('accepts a well-formed cursor, with or without an expiry', async () => {
    expect((await listPendingVouchers(db, { cursor: forge(valid) })).ok).toBe(true);
    expect((await listPendingVouchers(db, { cursor: forge({ ...valid, voucherExpiresAt: null }) })).ok).toBe(true);
  });

  it('rejects a cursor it did not issue', async () => {
    const page = await listPendingVouchers(db, { cursor: 'not-a-cursor' });
    expect(page).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'cursor' } } });
  });
});
