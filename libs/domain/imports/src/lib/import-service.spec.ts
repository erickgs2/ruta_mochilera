import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { APPLY_IMPORT_JOB, SEND_RECEIPT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { ok } from '@rm/shared-utils';
import type { PgBoss } from 'pg-boss';
import { applyImport, MAX_IMPORT_ROWS, requestImportApply, validateImport, type ApplyImportDeps } from './import-service';

const db = withTestDb();

class RecordingEmail implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return ok({ providerMessageId: `m${this.sent.length}` });
  }
}

let staffId: string;
let queue: PgBoss;
let email: RecordingEmail;
let deps: ApplyImportDeps;

const CUSTOMERS = [
  'full_name,email,phone,birth_date,locale',
  'María Peña,maria@example.com,352 100 80 79,1990-05-17,es',
  'Sin Fecha,sinfecha@example.com,352 100 80 79,,',
  'Ya Existe,ya@example.com,352 100 80 79,1990-01-01,',
].join('\n');

async function validateAndClaim(type: 'CUSTOMERS' | 'PAYMENTS', content: string, sendEmails = false) {
  const validated = await validateImport(db, { type, fileName: 'f.csv', content, sendEmails, actorId: staffId });
  if (!validated.ok) throw new Error(validated.error.code);
  const claimed = await requestImportApply(db, queue, { batchId: validated.value.id, actorId: staffId });
  if (!claimed.ok) throw new Error(claimed.error.code);
  return validated.value;
}

async function seedTrip(slug: string, status: 'PUBLISHED' | 'COMPLETED' = 'COMPLETED') {
  return db.trip.create({
    data: {
      slug,
      status,
      departureDate: new Date('2026-03-01'),
      returnDate: new Date('2026-03-07'),
      paymentDeadline: new Date('2026-02-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staffId,
    },
  });
}

async function seedCustomer(emailAddress: string) {
  return db.user.create({
    data: {
      email: emailAddress,
      type: 'CUSTOMER',
      customerProfile: { create: { fullName: 'Cliente', phone: '3521008079', birthDate: new Date('1990-01-01'), origin: 'IMPORT' } },
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
  staffId = (await db.user.create({ data: { email: 'admin@agency.test', type: 'STAFF' } })).id;
  email = new RecordingEmail();
  deps = { queue, mail: { email, clientAppUrl: 'https://rutamochilera.test/app' } };
});

afterAll(async () => {
  await closeTestQueue();
  await closeTestDb();
});

describe('validateImport', () => {
  it('writes nothing but the batch, with every row in the preview', async () => {
    await seedCustomer('ya@example.com');

    const batch = await validateImport(db, { type: 'CUSTOMERS', fileName: 'clientes.csv', content: CUSTOMERS, sendEmails: false, actorId: staffId });

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value).toMatchObject({ status: 'VALIDATED', rowsTotal: 3, rowsOk: 2, rowsFailed: 1 });
    expect(batch.value.report.rows.map((row) => row.status)).toEqual(['VALID', 'INVALID', 'EXISTS']);
    expect(batch.value.report.rows[1]?.errors).toEqual([{ column: 'birth_date', code: 'REQUIRED' }]);
    expect(await db.user.count({ where: { type: 'CUSTOMER' } })).toBe(1);
  });

  it('flags a birth date before 1900-01-01 as an INVALID_DATE row without aborting the batch', async () => {
    const content = [
      'full_name,email,phone,birth_date,locale',
      'María Peña,maria@example.com,352 100 80 79,1990-05-17,es',
      'Muy Antigua,antigua@example.com,352 100 80 79,1899-12-31,',
      'Justo Antes,justo@example.com,352 100 80 79,1900-01-01,',
    ].join('\n');

    const batch = await validateImport(db, { type: 'CUSTOMERS', fileName: 'clientes.csv', content, sendEmails: false, actorId: staffId });

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value).toMatchObject({ status: 'VALIDATED', rowsTotal: 3, rowsOk: 2, rowsFailed: 1 });
    expect(batch.value.report.rows.map((row) => row.status)).toEqual(['VALID', 'INVALID', 'VALID']);
    expect(batch.value.report.rows[1]?.errors).toEqual([{ column: 'birth_date', code: 'INVALID_DATE' }]);
  });

  it('stores an unusable file as FAILED with its file errors', async () => {
    const batch = await validateImport(db, { type: 'PAYMENTS', fileName: 'x.csv', content: 'nombre,correo\na,b', sendEmails: false, actorId: staffId });

    expect(batch.ok && batch.value.status).toBe('FAILED');
    expect(batch.ok && batch.value.report.fileErrors.map((error) => error.code)).toContain('MISSING_COLUMN');
  });

  it('refuses more than 5,000 rows or 5 MB', async () => {
    const tooMany = ['full_name,email,phone,birth_date,locale', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `N,n${i}@x.com,3521008079,1990-01-01,`)].join('\n');
    const tooBig = 'a'.repeat(5 * 1024 * 1024 + 1);

    expect(await validateImport(db, { type: 'CUSTOMERS', fileName: 'x', content: tooMany, sendEmails: false, actorId: staffId })).toMatchObject({
      ok: false,
      error: { code: 'IMPORT_TOO_LARGE' },
    });
    expect(await validateImport(db, { type: 'CUSTOMERS', fileName: 'x', content: tooBig, sendEmails: false, actorId: staffId })).toMatchObject({
      ok: false,
      error: { code: 'IMPORT_TOO_LARGE' },
    });
    expect(await db.importBatch.count()).toBe(0);
  });
});

describe('requestImportApply', () => {
  it('claims the batch once and enqueues the job; a second apply is IMPORT_ALREADY_APPLIED', async () => {
    const validated = await validateImport(db, { type: 'CUSTOMERS', fileName: 'f.csv', content: CUSTOMERS, sendEmails: false, actorId: staffId });
    if (!validated.ok) throw new Error();

    const first = await requestImportApply(db, queue, { batchId: validated.value.id, actorId: staffId });
    const second = await requestImportApply(db, queue, { batchId: validated.value.id, actorId: staffId });

    expect(first.ok && first.value.status).toBe('APPLYING');
    expect(second).toMatchObject({ ok: false, error: { code: 'IMPORT_ALREADY_APPLIED' } });
    expect((await queue.findJobs(APPLY_IMPORT_JOB, {})).map((job) => job.data)).toEqual([{ batchId: validated.value.id, actorId: staffId }]);
  });
});

describe('applyImport', () => {
  it('imports customers: valid rows created, invalid ones failed, known emails EXISTS without duplicating', async () => {
    const existing = await seedCustomer('ya@example.com');
    const batch = await validateAndClaim('CUSTOMERS', CUSTOMERS);

    const applied = await applyImport(db, deps, { batchId: batch.id, actorId: staffId });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).toMatchObject({ status: 'APPLIED', rowsOk: 2, rowsFailed: 1 });
    expect(applied.value.appliedAt).not.toBeNull();
    expect(applied.value.report.rows.map((row) => row.outcome)).toEqual(['CREATED', 'FAILED', 'EXISTS']);
    expect(applied.value.report.rows[2]?.entityId).toBe(existing.id);
    const maria = await db.user.findUniqueOrThrow({ where: { email: 'maria@example.com' }, include: { customerProfile: true } });
    expect(maria).toMatchObject({ passwordHash: null, customerProfile: { origin: 'IMPORT' } });
    expect(maria.emailVerifiedAt).not.toBeNull();
    expect(await db.user.count({ where: { email: 'ya@example.com' } })).toBe(1);
    expect(email.sent).toHaveLength(0);
    expect(await applyImport(db, deps, { batchId: batch.id, actorId: staffId })).toMatchObject({ ok: false, error: { code: 'IMPORT_ALREADY_APPLIED' } });
  });

  it('invites imported customers only when the batch says so, and never one who already existed', async () => {
    await seedCustomer('ya@example.com');
    const batch = await validateAndClaim('CUSTOMERS', CUSTOMERS, true);

    await applyImport(db, deps, { batchId: batch.id, actorId: staffId });

    expect(email.sent.map((message) => message.to)).toEqual(['maria@example.com']);
  });

  it('imports payments: creates the historical reservation when there is none, reuses a live one, and never imports a reference twice', async () => {
    const trip = await seedTrip('oaxaca-2026');
    const live = await seedTrip('cdmx-2026', 'PUBLISHED');
    const ana = await seedCustomer('ana@example.com');
    const luis = await seedCustomer('luis@example.com');
    const liveReservation = await db.reservation.create({
      data: {
        code: 'RM-LIVE',
        tripId: live.id,
        customerId: luis.id,
        status: 'ACTIVE',
        totalPriceCents: 500_000,
        minimumDepositCents: 100_000,
        paymentDeadline: live.paymentDeadline,
        source: 'APP',
      },
    });
    const content = [
      'customer_email,trip_slug,paid_at,amount,method,external_ref,notes',
      'ana@example.com,oaxaca-2026,2025-11-03,1500.10,CASH,REF-1,Anticipo',
      'ana@example.com,oaxaca-2026,2025-12-03,2000,,REF-2,',
      'luis@example.com,cdmx-2026,2026-01-10,9000,,REF-3,',
      'luis@example.com,cdmx-2026,2026-01-11,500,,REF-4,',
    ].join('\n');
    const batch = await validateAndClaim('PAYMENTS', content);

    const applied = await applyImport(db, deps, { batchId: batch.id, actorId: staffId });

    if (!applied.ok) throw new Error(applied.error.code);
    expect(applied.value.report.rows.map((row) => row.outcome)).toEqual(['CREATED', 'CREATED', 'FAILED', 'CREATED']);
    expect(applied.value.report.rows[2]?.outcomeCode).toBe('PAYMENT_EXCEEDS_BALANCE');

    const anaReservations = await db.reservation.findMany({ where: { customerId: ana.id }, include: { payments: true } });
    expect(anaReservations).toHaveLength(1);
    expect(anaReservations[0]).toMatchObject({ tripId: trip.id, status: 'ACTIVE', isBackfilled: true, paidCents: 350_010 });
    expect(anaReservations[0]?.payments.map((p) => [p.externalRef, p.amountCents, p.method, p.isBackfilled])).toEqual(
      expect.arrayContaining([
        ['REF-1', 150_010, 'CASH', true],
        ['REF-2', 200_000, 'LEGACY', true],
      ])
    );
    expect((await db.reservation.findUniqueOrThrow({ where: { id: liveReservation.id } })).paidCents).toBe(50_000);
    expect(await queue.findJobs(SEND_RECEIPT_JOB, {})).toEqual([]);

    // The same file again: every reference is already there.
    const again = await validateAndClaim('PAYMENTS', content);
    const second = await applyImport(db, deps, { batchId: again.id, actorId: staffId });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.report.rows.map((row) => row.outcome)).toEqual(['EXISTS', 'EXISTS', 'FAILED', 'EXISTS']);
    expect(await db.payment.count()).toBe(3);
  });
  describe('a payment dated today', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function importPaymentDatedToday(now: string) {
      await seedTrip('oaxaca-2026');
      await seedCustomer('ana@example.com');
      // Only `Date` is frozen: pg and pg-boss keep their real timers.
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
      const content = ['customer_email,trip_slug,paid_at,amount,method,external_ref,notes', 'ana@example.com,oaxaca-2026,2026-10-07,1000,CASH,TODAY-1,'].join('\n');
      const batch = await validateAndClaim('PAYMENTS', content);
      const applied = await applyImport(db, deps, { batchId: batch.id, actorId: staffId });
      if (!applied.ok) throw new Error(applied.error.code);
      return applied.value.report.rows[0];
    }

    it('before noon in the organization time zone is stamped now, never in the future', async () => {
      // 09:00 in Mexico City (UTC-6) on 2026-10-07.
      const now = '2026-10-07T15:00:00Z';

      const row = await importPaymentDatedToday(now);

      expect(row?.outcome).toBe('CREATED');
      const payment = await db.payment.findFirstOrThrow({ where: { externalRef: 'TODAY-1' } });
      expect(payment.paidAt!.getTime()).toBeLessThanOrEqual(new Date(now).getTime());
      expect(payment.paidAt!.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    });

    it('after noon keeps the noon stamp', async () => {
      // 15:00 in Mexico City.
      const row = await importPaymentDatedToday('2026-10-07T21:00:00Z');

      expect(row?.outcome).toBe('CREATED');
      const payment = await db.payment.findFirstOrThrow({ where: { externalRef: 'TODAY-1' } });
      expect(payment.paidAt!.toISOString()).toBe('2026-10-07T18:00:00.000Z');
    });
  });
});
