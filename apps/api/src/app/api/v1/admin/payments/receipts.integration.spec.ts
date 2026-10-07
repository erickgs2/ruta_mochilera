import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient } from '@rm/db';
import { recordPayment } from '@rm/domain-payments';
import { SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { FakeReceiptRenderer } from '@rm/receipts';
import { LocalFileStorage } from '@rm/storage';
import type { PgBoss } from 'pg-boss';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../lib/queue';
import { setReceiptRenderer } from '../../../../../lib/receipt-renderer';
import { setStorage } from '../../../../../lib/storage';
import { GET as myReceiptRoute } from '../../payments/[paymentId]/receipt/route';
import { POST as resendRoute } from './[paymentId]/receipt/resend/route';
import { GET as staffReceiptRoute } from './[paymentId]/receipt/route';
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '../settings/organization/route';

const db = withTestDb();

function request(url: string, token: string, method = 'GET') {
  return new Request(`http://localhost${url}`, { method, headers: { authorization: `Bearer ${token}` } });
}
const withPayment = (paymentId: string) => ({ params: Promise.resolve({ paymentId }) });

async function seedPaidReservation(customerId: string) {
  const creator = await db.user.create({ data: { email: 'creator@agency.test', type: 'STAFF' } });
  const trip = await db.trip.create({
    data: {
      slug: 'receipt-trip',
      status: 'PUBLISHED',
      departureDate: new Date('2028-03-01'),
      returnDate: new Date('2028-03-07'),
      paymentDeadline: new Date('2028-02-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: creator.id,
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: 'RM-RECEIPT',
      tripId: trip.id,
      customerId,
      status: 'ACTIVE',
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paymentDeadline: trip.paymentDeadline,
      source: 'BRANCH',
    },
  });
  const payment = await db.$transaction((tx: DbTransactionClient) =>
    recordPayment(tx, {
      reservationId: reservation.id,
      amountCents: 100_000,
      method: 'CASH',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      paidAt: new Date('2027-06-01T18:00:00Z'),
    })
  );
  if (!payment.ok) throw new Error(payment.error.code);
  return payment.value;
}

describe('receipt endpoints', () => {
  let storageRoot: string;
  let renderer: FakeReceiptRenderer;
  let queue: PgBoss;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    queue = await withTestQueue();
    setQueue(queue);
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
    storageRoot = mkdtempSync(join(tmpdir(), 'rm-receipt-api-'));
    setStorage(new LocalFileStorage(storageRoot, 'http://localhost/api/v1/files'));
    renderer = new FakeReceiptRenderer();
    setReceiptRenderer(renderer);
  });
  afterEach(() => {
    setStorage(undefined);
    setReceiptRenderer(undefined);
    rmSync(storageRoot, { recursive: true, force: true });
  });
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('lets staff with payment.view download a receipt, generating it once', async () => {
    const { userId } = await loginAsCustomer(db, 'traveler@example.com');
    const payment = await seedPaidReservation(userId);
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

    const first = await staffReceiptRoute(request(`/api/v1/admin/payments/${payment.id}/receipt`, token), withPayment(payment.id));
    const second = await staffReceiptRoute(request(`/api/v1/admin/payments/${payment.id}/receipt`, token), withPayment(payment.id));

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/pdf');
    expect(first.headers.get('content-disposition')).toContain('RM-2027-000001.pdf');
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect((await first.text()).startsWith('%PDF-')).toBe(true);
    expect(second.status).toBe(200);
    expect(renderer.rendered).toHaveLength(1);
  });

  it('refuses staff without payment.view', async () => {
    const { userId } = await loginAsCustomer(db, 'traveler@example.com');
    const payment = await seedPaidReservation(userId);
    const token = await loginAs(db, 'guide@agency.test', ['reservation.view']);

    const response = await staffReceiptRoute(request(`/api/v1/admin/payments/${payment.id}/receipt`, token), withPayment(payment.id));

    expect(response.status).toBe(403);
  });

  it('lets a customer download only their own receipts', async () => {
    const owner = await loginAsCustomer(db, 'traveler@example.com');
    const stranger = await loginAsCustomer(db, 'stranger@example.com');
    const payment = await seedPaidReservation(owner.userId);

    const mine = await myReceiptRoute(request(`/api/v1/payments/${payment.id}/receipt`, owner.token), withPayment(payment.id));
    const theirs = await myReceiptRoute(request(`/api/v1/payments/${payment.id}/receipt`, stranger.token), withPayment(payment.id));

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
    expect((await theirs.json()).code).toBe('RESERVATION_NOT_OWNED');
  });

  it('lets settings.manage edit the agency details: later receipts use them, issued ones do not change', async () => {
    const { userId } = await loginAsCustomer(db, 'traveler@example.com');
    const first = await seedPaidReservation(userId);
    const viewer = await loginAs(db, 'cashier@agency.test', ['payment.view']);
    const admin = await loginAs(db, 'owner@agency.test', ['settings.manage']);
    await db.systemSetting.create({ data: { key: 'organization.name', value: 'Nombre anterior' } });

    const before = await (await staffReceiptRoute(request(`/api/v1/admin/payments/${first.id}/receipt`, viewer), withPayment(first.id))).text();

    const forbidden = await putSettingsRoute(
      new Request('http://localhost/api/v1/admin/settings/organization', {
        method: 'PUT',
        body: JSON.stringify({ name: 'X', address: '', phone: '', website: '' }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${viewer}` },
      }),
      { params: Promise.resolve({}) }
    );
    expect(forbidden.status).toBe(403);

    const saved = await putSettingsRoute(
      new Request('http://localhost/api/v1/admin/settings/organization', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Casa Mochilera', address: 'Mariano Jiménez 551 B', phone: '352 100 80 79', website: 'www.fb.com/larutamochilera' }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      }),
      { params: Promise.resolve({}) }
    );
    expect(saved.status).toBe(200);
    const read = await getSettingsRoute(request('/api/v1/admin/settings/organization', admin), { params: Promise.resolve({}) });
    expect((await read.json()).name).toBe('Casa Mochilera');

    const after = await (await staffReceiptRoute(request(`/api/v1/admin/payments/${first.id}/receipt`, viewer), withPayment(first.id))).text();
    expect(after).toBe(before);
    expect(FakeReceiptRenderer.parse(new TextEncoder().encode(after)).organization.name).toBe('Nombre anterior');

    const second = await db.$transaction((tx: DbTransactionClient) =>
      recordPayment(tx, { reservationId: first.reservationId, amountCents: 1_000, method: 'CASH', status: 'SUCCEEDED', provider: 'MANUAL' })
    );
    if (!second.ok) throw new Error(second.error.code);
    const fresh = await (await staffReceiptRoute(request(`/api/v1/admin/payments/${second.value.id}/receipt`, viewer), withPayment(second.value.id))).text();
    expect(FakeReceiptRenderer.parse(new TextEncoder().encode(fresh)).organization.name).toBe('Casa Mochilera');
  });

  it('queues a resend with payment.view', async () => {
    const { userId } = await loginAsCustomer(db, 'traveler@example.com');
    const payment = await seedPaidReservation(userId);
    const token = await loginAs(db, 'cashier@agency.test', ['payment.view']);

    const response = await resendRoute(
      request(`/api/v1/admin/payments/${payment.id}/receipt/resend`, token, 'POST'),
      withPayment(payment.id)
    );

    expect(response.status).toBe(202);
    const jobs = await queue.findJobs(SEND_RECEIPT_JOB, {});
    expect(jobs.map((job) => job.data)).toEqual([{ paymentId: payment.id, resend: true }]);
  });
});
