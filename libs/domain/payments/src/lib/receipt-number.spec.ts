import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient } from '@rm/db';
import { confirmPayment, recordPayment } from './payment-service';
import { assignReceiptNumber } from './receipt-number';
import { seedReservation, seedStaff } from './test-fixtures';

const db = withTestDb();

let staffId: string;

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  staffId = await seedStaff(db);
  await db.systemSetting.createMany({
    data: [
      { key: 'organization.timezone', value: 'America/Mexico_City' },
      { key: 'receipt.prefix', value: 'RM' },
    ],
  });
});

afterAll(async () => {
  await closeTestDb();
});

async function cashPayment(reservationId: string, paidAt: Date, amountCents = 10_000) {
  const result = await db.$transaction((tx: DbTransactionClient) =>
    recordPayment(tx, {
      reservationId,
      amountCents,
      method: 'CASH',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      paidAt,
    })
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('assignReceiptNumber', () => {
  it('numbers the receipts of a year from one, in order', async () => {
    const reservation = await seedReservation(db, staffId);

    const first = await cashPayment(reservation.id, new Date('2027-03-10T18:00:00Z'));
    const second = await cashPayment(reservation.id, new Date('2027-03-11T18:00:00Z'));

    expect(first.receiptNumber).toBe('RM-2027-000001');
    expect(second.receiptNumber).toBe('RM-2027-000002');
  });

  it('takes the year from the paid date in the organization timezone', async () => {
    const reservation = await seedReservation(db, staffId);

    // 23:30 on 31 December in Mexico City is already 1 January in UTC.
    const lateOnNewYearsEve = await cashPayment(reservation.id, new Date('2027-01-01T05:30:00Z'));
    const nextMorning = await cashPayment(reservation.id, new Date('2027-01-01T15:00:00Z'));

    expect(lateOnNewYearsEve.receiptNumber).toBe('RM-2026-000001');
    expect(nextMorning.receiptNumber).toBe('RM-2027-000001');
  });

  it('uses the configured prefix', async () => {
    await db.systemSetting.update({ where: { key: 'receipt.prefix' }, data: { value: 'LRM' } });
    const reservation = await seedReservation(db, staffId);

    const payment = await cashPayment(reservation.id, new Date('2027-03-10T18:00:00Z'));

    expect(payment.receiptNumber).toBe('LRM-2027-000001');
  });

  it('hands twenty concurrent payments twenty consecutive numbers', async () => {
    const reservations = await Promise.all(
      Array.from({ length: 20 }, () => seedReservation(db, staffId))
    );

    const payments = await Promise.all(
      reservations.map((reservation) => cashPayment(reservation.id, new Date('2027-05-01T18:00:00Z')))
    );

    const numbers = payments.map((payment) => payment.receiptNumber).sort();
    expect(numbers).toEqual(
      Array.from({ length: 20 }, (_, i) => `RM-2027-${String(i + 1).padStart(6, '0')}`)
    );
  });

  it('leaves no gap when the transaction that took a number rolls back', async () => {
    const reservation = await seedReservation(db, staffId);

    await expect(
      db.$transaction(async (tx: DbTransactionClient) => {
        await assignReceiptNumber(tx, new Date('2027-05-01T18:00:00Z'));
        throw new Error('rolled back');
      })
    ).rejects.toThrow('rolled back');

    const payment = await cashPayment(reservation.id, new Date('2027-05-01T18:00:00Z'));
    expect(payment.receiptNumber).toBe('RM-2027-000001');
  });

  it('numbers a pending payment only when the webhook confirms it', async () => {
    const reservation = await seedReservation(db, staffId);
    const pending = await db.$transaction((tx: DbTransactionClient) =>
      recordPayment(tx, {
        reservationId: reservation.id,
        amountCents: 100_000,
        method: 'OXXO',
        status: 'PENDING',
        provider: 'STRIPE',
        providerIntentId: 'pi_receipt',
      })
    );
    expect(pending.ok && pending.value.receiptNumber).toBeNull();

    const confirmed = await confirmPayment(db, {
      providerIntentId: 'pi_receipt',
      paidAt: new Date('2027-05-02T18:00:00Z'),
    });
    expect(confirmed.ok && confirmed.value.receiptNumber).toBe('RM-2027-000001');

    // A redelivery confirms nothing new and takes no second number.
    const again = await confirmPayment(db, {
      providerIntentId: 'pi_receipt',
      paidAt: new Date('2027-05-02T18:00:00Z'),
    });
    expect(again.ok && again.value.receiptNumber).toBe('RM-2027-000001');
    expect((await db.receiptCounter.findUniqueOrThrow({ where: { year: 2027 } })).lastNumber).toBe(1);
  });

  it('never numbers a failed or expired payment', async () => {
    const reservation = await seedReservation(db, staffId);

    for (const status of ['FAILED', 'EXPIRED'] as const) {
      const result = await db.$transaction((tx: DbTransactionClient) =>
        recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 10_000,
          method: 'CARD',
          status,
          provider: 'STRIPE',
          providerIntentId: `pi_${status}`,
        })
      );
      expect(result.ok && result.value.receiptNumber).toBeNull();
    }
    expect(await db.receiptCounter.count()).toBe(0);
  });
});
