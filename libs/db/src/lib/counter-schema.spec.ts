import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDb,
  prepareTestDb,
  resetDatabase,
  uniqueViolationIndex,
  withTestDb,
} from '../testing';
import type { Db } from './client';

const db = withTestDb();

describe('phase 2b counter schema', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function createReservation(db: Db) {
    const staff = await db.user.create({
      data: { email: 'staff@agency.test', type: 'STAFF' },
    });
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2026',
        departureDate: new Date('2026-12-01'),
        returnDate: new Date('2026-12-07'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100000,
        createdById: staff.id,
      },
    });
    const customer = await db.user.create({
      data: {
        email: 'customer@agency.test',
        type: 'CUSTOMER',
        customerProfile: {
          create: {
            fullName: 'Pat Cliente',
            phone: '5512345678',
            birthDate: new Date('1990-01-01'),
            origin: 'BRANCH',
          },
        },
      },
    });
    return db.reservation.create({
      data: {
        code: 'RES-0001',
        tripId: trip.id,
        customerId: customer.id,
        status: 'ACTIVE',
        totalPriceCents: 500000,
        minimumDepositCents: 100000,
        paymentDeadline: new Date('2026-11-01'),
        source: 'BRANCH',
      },
    });
  }

  it('refuses a credit entry that moves no money', async () => {
    const reservation = await createReservation(db);

    const error = await db.customerCreditEntry
      .create({
        data: {
          customerId: reservation.customerId,
          amountCents: 0,
          kind: 'ADJUSTMENT',
          reason: 'nothing',
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      code: 'P2039',
      meta: {
        driverAdapterError: {
          cause: {
            code: '23514',
            message: expect.stringContaining('customer_credit_entries_amount_not_zero'),
          },
        },
      },
    });
  });

  it('stores signed credit entries', async () => {
    const reservation = await createReservation(db);

    const entry = await db.customerCreditEntry.create({
      data: {
        customerId: reservation.customerId,
        amountCents: -5000,
        kind: 'REFUND',
        reason: 'Returned in cash',
      },
    });

    expect(entry.amountCents).toBe(-5000);
  });

  it('rejects two payments with the same receipt number', async () => {
    const reservation = await createReservation(db);
    const payment = {
      reservationId: reservation.id,
      amountCents: 10000,
      method: 'CASH' as const,
      status: 'SUCCEEDED' as const,
      provider: 'MANUAL' as const,
      receiptNumber: 'RM-2027-000001',
    };

    await db.payment.create({ data: payment });
    const error = await db.payment
      .create({ data: payment })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'P2002' });
    expect(uniqueViolationIndex(error)).toBe('payments_receipt_number_key');
  });

  it('allows many payments without a receipt number yet', async () => {
    const reservation = await createReservation(db);

    for (let i = 0; i < 2; i++) {
      await db.payment.create({
        data: {
          reservationId: reservation.id,
          amountCents: 10000,
          method: 'OXXO',
          status: 'PENDING',
          provider: 'STRIPE',
        },
      });
    }

    expect(await db.payment.count()).toBe(2);
  });

  it('keys the receipt counter by year', async () => {
    await db.receiptCounter.create({ data: { year: 2027 } });

    const error = await db.receiptCounter
      .create({ data: { year: 2027 } })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'P2002' });
    expect((await db.receiptCounter.findUniqueOrThrow({ where: { year: 2027 } })).lastNumber).toBe(0);
  });

  it('keeps password resets as resets by default', async () => {
    const user = await db.user.create({
      data: { email: 'someone@agency.test', type: 'CUSTOMER' },
    });

    const reset = await db.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: 'hash',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });

    expect(reset.purpose).toBe('RESET');
  });

  it('no longer has a per-reservation credit column', async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'reservations'
    `;

    expect(columns.map((c) => c.column_name)).toContain('paid_cents');
    expect(columns.map((c) => c.column_name)).not.toContain('credit_cents');
  });
});
