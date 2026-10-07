import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Db, DbTransactionClient } from '@rm/db';
import { recordPayment } from '@rm/domain-payments';
import { PROVIDER_REJECTED_TEST_ADDRESS, type EmailMessage, type EmailProvider } from '@rm/email';
import { FakeReceiptRenderer } from '@rm/receipts';
import { fail, ok } from '@rm/shared-utils';
import { LocalFileStorage } from '@rm/storage';
import { sendReceipt } from './send-receipt';

const db = withTestDb();

class RecordingEmail implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  failing = false;

  async send(message: EmailMessage) {
    if (this.failing || message.to === PROVIDER_REJECTED_TEST_ADDRESS) {
      return fail('EMAIL_PROVIDER_ERROR', { reason: 'test' });
    }
    this.sent.push(message);
    return ok({ providerMessageId: `msg-${this.sent.length}` });
  }
}

let storageRoot: string;
let storage: LocalFileStorage;
let renderer: FakeReceiptRenderer;
let email: RecordingEmail;

async function seedReservation(client: Db, customerEmail = 'traveler@example.com') {
  const staff = await client.user.create({ data: { email: 'staff@agency.test', type: 'STAFF' } });
  const customer = await client.user.create({
    data: {
      email: customerEmail,
      type: 'CUSTOMER',
      locale: 'es',
      customerProfile: {
        create: { fullName: 'María Peña', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'BRANCH' },
      },
    },
  });
  const trip = await client.trip.create({
    data: {
      slug: 'real-de-catorce',
      status: 'PUBLISHED',
      departureDate: new Date('2027-03-12'),
      returnDate: new Date('2027-03-14'),
      paymentDeadline: new Date('2027-02-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staff.id,
      translations: {
        create: [{ locale: 'es', name: 'Real de Catorce', description: 'd', itinerary: 'i', includes: 'i', excludes: 'e' }],
      },
    },
  });
  return client.reservation.create({
    data: {
      code: 'RM-7K2Q9X',
      tripId: trip.id,
      customerId: customer.id,
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'BRANCH',
    },
  });
}

async function cash(reservationId: string, amountCents: number, paidAt: Date) {
  const result = await db.$transaction((tx: DbTransactionClient) =>
    recordPayment(tx, { reservationId, amountCents, method: 'CASH', status: 'SUCCEEDED', provider: 'MANUAL', paidAt })
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('sendReceipt', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    storageRoot = mkdtempSync(join(tmpdir(), 'rm-receipts-test-'));
    storage = new LocalFileStorage(storageRoot, 'http://localhost/api/v1/files');
    renderer = new FakeReceiptRenderer();
    email = new RecordingEmail();
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('stores the PDF, emails it to the customer and stamps receipt_sent_at', async () => {
    const reservation = await seedReservation(db);
    const payment = await cash(reservation.id, 150_000, new Date('2027-01-10T18:00:00Z'));

    const result = await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });

    expect(result).toEqual({ ok: true, value: 'SENT' });
    const stored = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.receiptKey).toMatch(/^receipts\/2027\/RM-2027-000001-[0-9a-f-]{36}\.pdf$/);
    expect(stored.receiptSentAt).not.toBeNull();
    expect(await storage.exists(stored.receiptKey as string)).toBe(true);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: 'traveler@example.com', subject: 'Tu recibo de pago RM-2027-000001' });
    expect(email.sent[0]?.attachments?.[0]).toMatchObject({ filename: 'RM-2027-000001.pdf', contentType: 'application/pdf' });
  });

  it('sends to the address the customer has now', async () => {
    const reservation = await seedReservation(db);
    const payment = await cash(reservation.id, 150_000, new Date('2027-01-10T18:00:00Z'));
    await db.user.update({ where: { id: reservation.customerId }, data: { email: 'new-address@example.com' } });

    await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });

    expect(email.sent[0]?.to).toBe('new-address@example.com');
  });

  it('never sends the same receipt twice, and never regenerates its PDF', async () => {
    const reservation = await seedReservation(db);
    const payment = await cash(reservation.id, 150_000, new Date('2027-01-10T18:00:00Z'));

    await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });
    const again = await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });

    expect(again).toEqual({ ok: true, value: 'ALREADY_SENT' });
    expect(email.sent).toHaveLength(1);

    const resent = await sendReceipt(db, storage, renderer, email, { paymentId: payment.id, resend: true });
    expect(resent).toEqual({ ok: true, value: 'SENT' });
    expect(email.sent).toHaveLength(2);
    expect(renderer.rendered).toHaveLength(1);
  });

  it('prints the balance of that moment, not today', async () => {
    const reservation = await seedReservation(db);
    const first = await cash(reservation.id, 100_000, new Date('2027-01-10T18:00:00Z'));
    await cash(reservation.id, 200_000, new Date('2027-01-20T18:00:00Z'));

    await sendReceipt(db, storage, renderer, email, { paymentId: first.id });

    const pdf = email.sent[0]?.attachments?.[0]?.content as Uint8Array;
    expect(FakeReceiptRenderer.parse(pdf)).toMatchObject({
      receiptNumber: 'RM-2027-000001',
      amountCents: 100_000,
      totalCents: 500_000,
      paidCents: 100_000,
      balanceCents: 400_000,
      customerName: 'María Peña',
      tripName: 'Real de Catorce',
      reservationCode: 'RM-7K2Q9X',
      locale: 'es',
    });
  });

  it('keeps the PDF and leaves receipt_sent_at null when the provider fails', async () => {
    const reservation = await seedReservation(db, PROVIDER_REJECTED_TEST_ADDRESS);
    const payment = await cash(reservation.id, 150_000, new Date('2027-01-10T18:00:00Z'));

    const result = await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });

    expect(result).toMatchObject({ ok: false, error: { code: 'EMAIL_PROVIDER_ERROR' } });
    const stored = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.receiptKey).not.toBeNull();
    expect(stored.receiptSentAt).toBeNull();

    // The retry sends the stored PDF without rendering it again.
    await db.user.update({ where: { id: reservation.customerId }, data: { email: 'traveler@example.com' } });
    await sendReceipt(db, storage, renderer, email, { paymentId: payment.id });
    expect(email.sent).toHaveLength(1);
    expect(renderer.rendered).toHaveLength(1);
  });

  it('skips a payment that has no receipt', async () => {
    const reservation = await seedReservation(db);
    const pending = await db.payment.create({
      data: { reservationId: reservation.id, amountCents: 100, method: 'OXXO', status: 'PENDING', provider: 'STRIPE' },
    });

    const result = await sendReceipt(db, storage, renderer, email, { paymentId: pending.id });

    expect(result).toEqual({ ok: true, value: 'NO_RECEIPT' });
    expect(email.sent).toHaveLength(0);
  });
});
