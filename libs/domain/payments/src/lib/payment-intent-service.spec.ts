import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, Reservation, ReservationStatus } from '@rm/db';
import { FakePaymentProvider, StripePaymentProvider } from '@rm/payments-stripe';
import { createPaymentIntentForReservation } from './payment-intent-service';

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;

let staffId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

/**
 * Same reasoning as `payment-service.spec.ts`'s own `seedReservation`:
 * seeded directly through Prisma, never through `@rm/domain-reservations`,
 * so this leaf library's test suite does not grow the one dependency its
 * own doc comment forbids.
 */
async function seedReservation(
  client: Db,
  overrides: {
    status?: ReservationStatus;
    totalPriceCents?: number;
    minimumDepositCents?: number;
    paidCents?: number;
    holdExpiresAt?: Date | null;
    customerId?: string;
  } = {}
): Promise<Reservation> {
  const index = next();
  const customerId = overrides.customerId ?? (await seedCustomer(client));
  const trip = await client.trip.create({
    data: {
      slug: `oaxaca-intent-${index}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      pricePerSeatCents: overrides.totalPriceCents ?? 500_000,
      createdById: staffId,
    },
  });

  const status = overrides.status ?? 'HELD';
  return client.reservation.create({
    data: {
      code: `RM-INTENT${index}`,
      tripId: trip.id,
      customerId,
      status,
      holdExpiresAt:
        overrides.holdExpiresAt === undefined
          ? status === 'HELD'
            ? new Date(Date.now() + 72 * HOUR_MS)
            : null
          : overrides.holdExpiresAt,
      totalPriceCents: overrides.totalPriceCents ?? 500_000,
      minimumDepositCents: overrides.minimumDepositCents ?? 100_000,
      paidCents: overrides.paidCents ?? 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
}

async function seedCustomer(client: Db): Promise<string> {
  const index = next();
  const user = await client.user.create({
    data: {
      email: `customer-intent-${index}@agency.test`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: {
          fullName: `Cliente ${index}`,
          phone: '5512345678',
          birthDate: new Date('1990-01-01'),
          origin: 'SELF_SIGNUP',
        },
      },
    },
  });
  return user.id;
}

describe('createPaymentIntentForReservation', () => {
  let provider: FakePaymentProvider;

  beforeAll(() => prepareTestDb());
  beforeEach(async () => {
    await resetDatabase(db);
    provider = new FakePaymentProvider();
    const staff = await db.user.create({
      data: { email: 'staff-intent@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Staff' } } },
    });
    staffId = staff.id;
  });
  afterAll(() => closeTestDb());

  it('computes a FULL intent from the reservation balance, never from a client-supplied amount', async () => {
    const reservation = await seedReservation(db, { totalPriceCents: 500_000, paidCents: 100_000 });

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'FULL',
      method: 'CARD',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 500_000 - 100_000 paid = 400_000 balance, computed entirely server-side:
    // `CreatePaymentIntentInput` carries no `amountCents` field for a caller
    // to have supplied one.
    expect(result.value.amountCents).toBe(400_000);

    const row = await db.payment.findUniqueOrThrow({ where: { providerIntentId: result.value.providerIntentId } });
    expect(row.amountCents).toBe(400_000);
    expect(row.status).toBe('PENDING');
    expect(row.provider).toBe('STRIPE');
  });

  it('computes a DEPOSIT intent as the minimum deposit still owed, capped at the balance', async () => {
    const reservation = await seedReservation(db, {
      totalPriceCents: 500_000,
      minimumDepositCents: 150_000,
      paidCents: 50_000,
    });

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'DEPOSIT',
      method: 'CARD',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amountCents).toBe(100_000);
  });

  it('returns RESERVATION_NOT_OWNED, never a different code, for someone else\'s reservation', async () => {
    const reservation = await seedReservation(db);
    const stranger = await seedCustomer(db);

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: stranger,
      intent: 'FULL',
      method: 'CARD',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESERVATION_NOT_OWNED');
    expect(await db.payment.count()).toBe(0);
  });

  it('returns RESERVATION_NOT_OWNED for a reservation id that does not exist at all -- same code as "not yours"', async () => {
    const customerId = await seedCustomer(db);

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: '00000000-0000-0000-0000-000000000000',
      customerId,
      intent: 'FULL',
      method: 'CARD',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESERVATION_NOT_OWNED');
  });

  it.each(['EXPIRED', 'CANCELLED'] as const)('refuses an intent for a %s reservation', async (status) => {
    const reservation = await seedReservation(db, { status, holdExpiresAt: null });

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'FULL',
      method: 'CARD',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(await db.payment.count()).toBe(0);
  });

  it("sets the OXXO voucher expiry to exactly the reservation's holdExpiresAt", async () => {
    const holdExpiresAt = new Date(Date.now() + 48 * HOUR_MS);
    const reservation = await seedReservation(db, { holdExpiresAt });

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'FULL',
      method: 'OXXO',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.voucherExpiresAt).toEqual(holdExpiresAt);
    expect(result.value.voucherUrl).toBeDefined();

    const row = await db.payment.findUniqueOrThrow({ where: { providerIntentId: result.value.providerIntentId } });
    expect(row.voucherExpiresAt).toEqual(holdExpiresAt);
    expect(row.providerVoucherUrl).toBe(result.value.voucherUrl);
  });

  it('surfaces the real Stripe adapter refusing a sub-24h OXXO window as a clean Result, never a thrown exception', async () => {
    // `StripePaymentProvider.createIntent` refuses to create an OXXO intent
    // when less than a day remains before `voucherExpiresAt` (see
    // `oxxoExpiresAfterDays` in `@rm/payments-stripe`): Stripe's own voucher
    // parameter only accepts a whole number of days, and clamping a
    // sub-24-hour window up to one day would let the voucher outlive the
    // hold. This never reaches the network -- the refusal happens before
    // any `fetch` call -- so a fake secret key is enough to exercise it.
    const stripe = new StripePaymentProvider('sk_test_fake', 'whsec_test_fake');
    const holdExpiresAt = new Date(Date.now() + 2 * HOUR_MS);
    const reservation = await seedReservation(db, { holdExpiresAt });

    const result = await createPaymentIntentForReservation(db, stripe, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'FULL',
      method: 'OXXO',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.details).toMatchObject({ field: 'voucherExpiresAt', reason: 'window_too_short_for_oxxo' });
    expect(await db.payment.count()).toBe(0);
  });

  it('refuses an intent that would charge nothing (deposit already fully covered)', async () => {
    const reservation = await seedReservation(db, {
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: 500_000,
      status: 'ACTIVE',
      holdExpiresAt: null,
    });

    const result = await createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      intent: 'FULL',
      method: 'CARD',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(await db.payment.count()).toBe(0);
  });
});
