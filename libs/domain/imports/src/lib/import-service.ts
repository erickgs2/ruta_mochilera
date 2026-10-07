import type { Db, DbTransactionClient, ImportBatch, ImportStatus, Prisma } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { createImportedCustomer, type CustomerMailContext } from '@rm/domain-customers';
import { createBackfilledPaymentsHook, recordBackfilledPayments, type ReceiptQueue } from '@rm/domain-payments';
import { createBackfilledReservation } from '@rm/domain-reservations';
import { organizationTimeZone } from '@rm/domain-settings';
import { APPLY_IMPORT_JOB, type ApplyImportPayload } from '@rm/jobs';
import { fail, ok, type DomainError, type Result } from '@rm/shared-utils';
import { DateTime } from 'luxon';
import { fromPrisma } from 'pg-boss';
import { parseCsv } from './csv';
import { parsePesosToCents } from './money';
import type { ImportType } from './templates';
import { readTable, validateRows, type ImportLookups, type ImportReport, type ImportRowReport } from './validate-rows';

/** Spec §5.8: at most 5,000 rows and 5 MB per file. */
export const MAX_IMPORT_ROWS = 5_000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** How often the worker saves its progress into the report while applying. */
const CHECKPOINT_EVERY = 100;

export interface ImportBatchSummaryDto {
  id: string;
  type: ImportType;
  fileName: string;
  status: ImportStatus;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  sendEmails: boolean;
  createdAt: Date;
  appliedAt: Date | null;
}

export interface ImportBatchDto extends ImportBatchSummaryDto {
  report: ImportReport;
}

export interface ValidateImportInput {
  type: ImportType;
  fileName: string;
  content: string;
  sendEmails: boolean;
  actorId: string;
}

export interface ApplyImportDeps {
  queue: ReceiptQueue;
  mail: CustomerMailContext;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSummary(batch: ImportBatch): ImportBatchSummaryDto {
  return {
    id: batch.id,
    type: batch.type,
    fileName: batch.fileName,
    status: batch.status,
    rowsTotal: batch.rowsTotal,
    rowsOk: batch.rowsOk,
    rowsFailed: batch.rowsFailed,
    sendEmails: batch.sendEmails,
    createdAt: batch.createdAt,
    appliedAt: batch.appliedAt,
  };
}

function toDto(batch: ImportBatch): ImportBatchDto {
  return { ...toSummary(batch), report: batch.report as unknown as ImportReport };
}

/** Everything the rows mention, read in a handful of queries rather than one per row. */
async function loadLookups(db: Db, type: ImportType, rows: { values: Record<string, string> }[]): Promise<ImportLookups> {
  const emails = [
    ...new Set(rows.map((row) => (row.values[type === 'CUSTOMERS' ? 'email' : 'customer_email'] ?? '').toLowerCase()).filter(Boolean)),
  ];
  const users = emails.length
    ? await db.user.findMany({
        where: { OR: emails.map((email) => ({ email: { equals: email, mode: 'insensitive' as const } })) },
        select: { id: true, email: true, type: true },
      })
    : [];
  const slugs = [...new Set(rows.map((row) => row.values['trip_slug'] ?? '').filter(Boolean))];
  const trips = slugs.length
    ? await db.trip.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true, status: true } })
    : [];
  const refs = [...new Set(rows.map((row) => row.values['external_ref'] ?? '').filter(Boolean))];
  const imported = refs.length
    ? await db.payment.findMany({ where: { externalRef: { in: refs } }, select: { externalRef: true } })
    : [];
  const timeZone = await organizationTimeZone(db);

  return {
    customersByEmail: new Map(users.filter((user) => user.type === 'CUSTOMER').map((user) => [user.email.toLowerCase(), user.id])),
    staffEmails: new Set(users.filter((user) => user.type !== 'CUSTOMER').map((user) => user.email.toLowerCase())),
    tripsBySlug: new Map(trips.map((trip) => [trip.slug, { id: trip.id, status: trip.status }])),
    importedRefs: new Set(imported.map((payment) => payment.externalRef as string)),
    today: DateTime.now().setZone(timeZone).toISODate() as string,
  };
}

function counts(rows: ImportRowReport[]): { rowsOk: number; rowsFailed: number } {
  const failed = rows.filter((row) => (row.outcome ? row.outcome === 'FAILED' : row.status === 'INVALID')).length;
  return { rowsOk: rows.length - failed, rowsFailed: failed };
}

/**
 * Reads and validates an uploaded file without writing anything but the
 * batch itself (`import.manage`). Every row comes back in the preview with
 * its errors (column and code) or as `EXISTS`. A file that is not an import
 * at all (no header, missing columns, no rows) is stored as `FAILED` with its
 * file-level errors; more than 5,000 rows or 5 MB is `IMPORT_TOO_LARGE`.
 */
export async function validateImport(db: Db, input: ValidateImportInput): Promise<Result<ImportBatchDto>> {
  if (Buffer.byteLength(input.content, 'utf8') > MAX_IMPORT_BYTES) {
    return fail('IMPORT_TOO_LARGE', { maxBytes: MAX_IMPORT_BYTES });
  }
  const table = parseCsv(input.content);
  if (table.length - 1 > MAX_IMPORT_ROWS) return fail('IMPORT_TOO_LARGE', { maxRows: MAX_IMPORT_ROWS });

  const { columns, fileErrors, records } = readTable(input.type, table);
  const rows = fileErrors.length === 0 ? validateRows(input.type, records, await loadLookups(db, input.type, records)) : [];
  const report: ImportReport = { columns, fileErrors, rows };

  const batch = await db.$transaction(async (tx: DbTransactionClient) => {
    const created = await tx.importBatch.create({
      data: {
        type: input.type,
        fileName: input.fileName,
        status: fileErrors.length > 0 ? 'FAILED' : 'VALIDATED',
        rowsTotal: records.length,
        ...counts(rows),
        report: report as unknown as Prisma.InputJsonValue,
        sendEmails: input.sendEmails,
        createdById: input.actorId,
      },
    });
    await recordAudit(tx, {
      actorUserId: input.actorId,
      action: 'import.validated',
      entityType: 'ImportBatch',
      entityId: created.id,
      after: { type: input.type, fileName: input.fileName, rows: records.length, status: created.status },
    });
    return created;
  });
  return ok(toDto(batch));
}

/**
 * Confirms a validated batch: claims it (`VALIDATED → APPLYING`, a
 * conditional update, so two clicks cannot both start it) and enqueues the
 * worker job in the same transaction. Applying twice is
 * `IMPORT_ALREADY_APPLIED`; a `FAILED` file is `INVALID_STATUS_TRANSITION`.
 */
export async function requestImportApply(
  db: Db,
  queue: ReceiptQueue,
  input: { batchId: string; actorId: string }
): Promise<Result<ImportBatchDto>> {
  if (!UUID_PATTERN.test(input.batchId)) return fail('NOT_FOUND');
  return db.$transaction(async (tx: DbTransactionClient): Promise<Result<ImportBatchDto>> => {
    const claimed = await tx.importBatch.updateMany({
      where: { id: input.batchId, status: 'VALIDATED' },
      data: { status: 'APPLYING' },
    });
    const batch = await tx.importBatch.findUnique({ where: { id: input.batchId } });
    if (!batch) return fail('NOT_FOUND');
    if (claimed.count === 0) {
      return batch.status === 'FAILED'
        ? fail('INVALID_STATUS_TRANSITION', { status: batch.status })
        : fail('IMPORT_ALREADY_APPLIED');
    }
    const payload: ApplyImportPayload = { batchId: batch.id, actorId: input.actorId };
    // Never retried (see `applyImport`), and given an hour: 5,000 rows with
    // their invitations can take far longer than pg-boss's 15-minute default.
    await queue.send(APPLY_IMPORT_JOB, payload, { db: fromPrisma(tx), retryLimit: 0, expireInSeconds: 3600 });
    await recordAudit(tx, {
      actorUserId: input.actorId,
      action: 'import.apply_requested',
      entityType: 'ImportBatch',
      entityId: batch.id,
    });
    return ok(toDto(batch));
  });
}

/** The payment's `external_ref` was imported by someone else in the meantime: it already exists. */
function isDuplicateRef(error: DomainError): boolean {
  return error.code === 'CONFLICT' && error.details?.['field'] === 'externalRef';
}

/**
 * Noon of a calendar date in the organization's timezone (never the day
 * before or after), but never later than now: a payment dated today and
 * imported before noon is stamped at the import moment, because a backfilled
 * payment cannot be in the future.
 */
function paidAtFor(date: string, timeZone: string): Date {
  const noon = DateTime.fromISO(date, { zone: timeZone }).set({ hour: 12 }).toJSDate();
  const now = new Date();
  return noon.getTime() > now.getTime() ? now : noon;
}

async function applyCustomerRow(db: Db, deps: ApplyImportDeps, row: ImportRowReport, sendEmails: boolean, actorId: string) {
  const values = row.values;
  const created = await createImportedCustomer(
    db,
    deps.mail,
    {
      fullName: values['full_name'] ?? '',
      email: values['email'] ?? '',
      phone: values['phone'] ?? '',
      birthDate: values['birth_date'] ?? '',
      locale: (values['locale'] || 'es').toLowerCase() as 'es' | 'en',
    },
    { sendInvitation: sendEmails, actorId }
  );
  if (!created.ok) return { outcome: 'FAILED' as const, outcomeCode: created.error.code };
  return { outcome: created.value.status, entityId: created.value.customerId };
}

async function applyPaymentRow(
  db: Db,
  deps: ApplyImportDeps,
  row: ImportRowReport,
  lookups: ImportLookups,
  context: { sendEmails: boolean; actorId: string; timeZone: string }
) {
  const values = row.values;
  const customerId = lookups.customersByEmail.get((values['customer_email'] ?? '').toLowerCase()) as string;
  const trip = lookups.tripsBySlug.get(values['trip_slug'] ?? '') as { id: string };
  const paidAt = paidAtFor(values['paid_at'] ?? '', context.timeZone);
  const payment = {
    amountCents: parsePesosToCents(values['amount'] ?? '') as number,
    paidAt,
    method: ((values['method'] || 'LEGACY').toUpperCase()) as 'LEGACY' | 'CASH' | 'CARD' | 'OXXO' | 'SPEI',
    notes: values['notes'] || undefined,
    externalRef: values['external_ref'] || undefined,
  };

  const live = await db.reservation.findFirst({
    where: { tripId: trip.id, customerId, status: { in: ['HELD', 'ACTIVE'] } },
    select: { id: true },
  });
  if (live) {
    const recorded = await recordBackfilledPayments(db, deps.queue, {
      reservationId: live.id,
      actorId: context.actorId,
      payments: [payment],
      sendReceipts: context.sendEmails,
    });
    if (recorded.ok) return { outcome: 'CREATED' as const, entityId: recorded.value[0]?.id };
    return isDuplicateRef(recorded.error)
      ? { outcome: 'EXISTS' as const }
      : { outcome: 'FAILED' as const, outcomeCode: recorded.error.code };
  }

  // No live reservation for this customer on this trip: the payment brings
  // its historical reservation with it (§5.7), dated the day of the payment.
  const created = await createBackfilledReservation(db, {
    tripId: trip.id,
    customerId,
    actorId: context.actorId,
    createdAt: paidAt.getTime() > Date.now() ? new Date() : paidAt,
    recordPayments: createBackfilledPaymentsHook(deps.queue, [payment], context.sendEmails),
  });
  if (created.ok) return { outcome: 'CREATED' as const, entityId: created.value.id };
  return isDuplicateRef(created.error)
    ? { outcome: 'EXISTS' as const }
    : { outcome: 'FAILED' as const, outcomeCode: created.error.code };
}

/**
 * The `APPLY_IMPORT` job: applies a claimed batch row by row. A row that
 * fails does not stop the others; the report says which passed, which
 * already existed and which failed and why. Each row is validated again
 * right before it is applied (lookups refreshed), so a customer created or a
 * payment imported since the preview is seen. Progress is saved into the
 * report every 100 rows and at the end, when the batch becomes `APPLIED`.
 *
 * Not retried by the worker: a payment row without `external_ref` cannot be
 * told apart from a second copy of itself, so a crash leaves the batch
 * `APPLYING` with its partial report for a person to look at, rather than
 * risking duplicates.
 */
export async function applyImport(db: Db, deps: ApplyImportDeps, payload: ApplyImportPayload): Promise<Result<ImportBatchDto>> {
  const batch = await db.importBatch.findUnique({ where: { id: payload.batchId } });
  if (!batch) return fail('NOT_FOUND');
  if (batch.status !== 'APPLYING') return fail('IMPORT_ALREADY_APPLIED');

  const type = batch.type as ImportType;
  const report = batch.report as unknown as ImportReport;
  const timeZone = await organizationTimeZone(db);
  const save = async (status: ImportStatus) =>
    db.importBatch.update({
      where: { id: batch.id },
      data: {
        status,
        report: report as unknown as Prisma.InputJsonValue,
        ...counts(report.rows),
        ...(status === 'APPLIED' ? { appliedAt: new Date() } : {}),
      },
    });

  for (const [index, row] of report.rows.entries()) {
    if (row.outcome) continue;
    const lookups = await loadLookups(db, type, [row]);
    const [revalidated] = validateRows(type, [{ row: row.row, values: row.values }], lookups);
    if (!revalidated || revalidated.status === 'INVALID') {
      row.status = 'INVALID';
      row.errors = revalidated?.errors ?? row.errors;
      row.outcome = 'FAILED';
      row.outcomeCode = 'VALIDATION_FAILED';
    } else if (revalidated.status === 'EXISTS') {
      row.outcome = 'EXISTS';
      row.entityId = revalidated.entityId;
    } else {
      const applied =
        type === 'CUSTOMERS'
          ? await applyCustomerRow(db, deps, row, batch.sendEmails, payload.actorId)
          : await applyPaymentRow(db, deps, row, lookups, { sendEmails: batch.sendEmails, actorId: payload.actorId, timeZone });
      Object.assign(row, applied);
    }
    if ((index + 1) % CHECKPOINT_EVERY === 0) await save('APPLYING');
  }

  const applied = await save('APPLIED');
  await recordAudit(db, {
    actorUserId: payload.actorId,
    action: 'import.applied',
    entityType: 'ImportBatch',
    entityId: batch.id,
    after: counts(report.rows),
  });
  return ok(toDto(applied));
}

export async function getImportBatch(db: Db, batchId: string): Promise<Result<ImportBatchDto>> {
  if (!UUID_PATTERN.test(batchId)) return fail('NOT_FOUND');
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  return batch ? ok(toDto(batch)) : fail('NOT_FOUND');
}

/** The latest batches, newest first, without their reports. */
export async function listImportBatches(db: Db, limit = 50): Promise<Result<ImportBatchSummaryDto[]>> {
  const batches = await db.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return ok(batches.map(toSummary));
}
