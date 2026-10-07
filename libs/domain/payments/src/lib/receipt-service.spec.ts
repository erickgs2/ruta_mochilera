import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient } from '@rm/db';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { recordPayment } from './payment-service';
import { enqueueReceipt, loadReceipt, receiptEmailMessage, receiptStorageKey, requestReceiptResend } from './receipt-service';
import { seedReservation, seedStaff } from './test-fixtures';

const db = withTestDb();

let staffId: string;
let queue: PgBoss;

beforeAll(async () => {
  await prepareTestDb();
  queue = await withTestQueue();
});

beforeEach(async () => {
  await resetDatabase(db);
  await resetTestQueue();
  staffId = await seedStaff(db);
});

afterAll(async () => {
  await closeTestQueue();
  await closeTestDb();
});

describe('enqueueReceipt', () => {
  it('enqueues on the caller transaction: a rollback takes the job with it', async () => {
    const reservation = await seedReservation(db, staffId);

    await expect(
      db.$transaction(async (tx: DbTransactionClient) => {
        const payment = await recordPayment(tx, {
          reservationId: reservation.id,
          amountCents: 10_000,
          method: 'CASH',
          status: 'SUCCEEDED',
          provider: 'MANUAL',
        });
        if (!payment.ok) throw new Error(payment.error.code);
        await enqueueReceipt(tx, queue, payment.value.id);
        throw new Error('rolled back');
      })
    ).rejects.toThrow('rolled back');

    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);
    expect(await db.payment.count()).toBe(0);
  });
});

describe('requestReceiptResend', () => {
  it('refuses a payment that has no receipt', async () => {
    const reservation = await seedReservation(db, staffId);
    const pending = await db.payment.create({
      data: { reservationId: reservation.id, amountCents: 100, method: 'OXXO', status: 'PENDING', provider: 'STRIPE' },
    });

    expect(await requestReceiptResend(db, queue, pending.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await requestReceiptResend(db, queue, 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);
  });
});

describe('loadReceipt', () => {
  it('rebuilds the balance for a payment confirmed before the snapshot existed', async () => {
    const reservation = await seedReservation(db, staffId, { status: 'ACTIVE', paidCents: 300_000 });
    const base = { reservationId: reservation.id, method: 'CARD' as const, status: 'SUCCEEDED' as const, provider: 'STRIPE' as const };
    await db.payment.create({ data: { ...base, amountCents: 100_000, paidAt: new Date('2027-01-01T18:00:00Z'), receiptNumber: 'RM-2027-000001' } });
    const second = await db.payment.create({
      data: { ...base, amountCents: 100_000, paidAt: new Date('2027-02-01T18:00:00Z'), receiptNumber: 'RM-2027-000002' },
    });
    await db.payment.create({ data: { ...base, amountCents: 100_000, paidAt: new Date('2027-03-01T18:00:00Z'), receiptNumber: 'RM-2027-000003' } });

    const loaded = await loadReceipt(db, second.id);

    expect(loaded.ok && loaded.value.data).toMatchObject({ totalCents: 500_000, paidCents: 200_000, balanceCents: 300_000 });
  });

  it('writes the email in the customer language with the PDF attached', async () => {
    const reservation = await seedReservation(db, staffId);
    await db.user.update({ where: { id: reservation.customerId }, data: { locale: 'en' } });
    const payment = await db.$transaction((tx: DbTransactionClient) =>
      recordPayment(tx, { reservationId: reservation.id, amountCents: 10_000, method: 'CASH', status: 'SUCCEEDED', provider: 'MANUAL' })
    );
    if (!payment.ok) throw new Error(payment.error.code);

    const loaded = await loadReceipt(db, payment.value.id);
    if (!loaded.ok) throw new Error(loaded.error.code);
    const message = receiptEmailMessage(loaded.value, new Uint8Array([1, 2, 3]));

    expect(message.subject).toMatch(/^Your payment receipt RM-\d{4}-000001$/);
    expect(message.text).toContain('$100.00 MXN');
    expect(message.attachments).toEqual([
      { filename: expect.stringMatching(/^RM-\d{4}-000001\.pdf$/), contentType: 'application/pdf', content: new Uint8Array([1, 2, 3]) },
    ]);
  });
});

describe('receiptStorageKey', () => {
  it('files a receipt under its year with an unguessable suffix', () => {
    expect(receiptStorageKey('RM-2027-000042')).toMatch(/^receipts\/2027\/RM-2027-000042-[0-9a-f-]{36}\.pdf$/);
    expect(receiptStorageKey('RM-2027-000042')).not.toBe(receiptStorageKey('RM-2027-000042'));
  });

  it('keeps a prefix with unusual characters inside the storage charset', () => {
    expect(receiptStorageKey('LA RUTA-2027-000001')).toMatch(/^receipts\/2027\/LA_RUTA-2027-000001-/);
  });
});
