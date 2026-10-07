import { DateTime } from 'luxon';
import { parsePesosToCents } from './money';
import { IMPORT_COLUMNS, OPTIONAL_COLUMNS, type ImportType } from './templates';

/**
 * Row-by-row validation of an import, without touching the database: every
 * lookup it needs is handed in. The same function runs when the file is
 * uploaded (the preview) and again right before each row is applied, so a
 * customer created or a payment imported in between is seen.
 */

export type ImportErrorCode =
  | 'REQUIRED'
  | 'INVALID_EMAIL'
  | 'INVALID_DATE'
  | 'INVALID_AMOUNT'
  | 'INVALID_PHONE'
  | 'INVALID_LOCALE'
  | 'EMAIL_TAKEN'
  | 'UNKNOWN_TRIP'
  | 'TRIP_NOT_ALLOWED'
  | 'UNKNOWN_CUSTOMER'
  | 'UNKNOWN_METHOD'
  | 'DUPLICATE_IN_FILE';

export type FileErrorCode = 'EMPTY_FILE' | 'MISSING_COLUMN' | 'NO_ROWS';

export interface ImportRowError {
  column: string;
  code: ImportErrorCode;
}

export type RowStatus = 'VALID' | 'INVALID' | 'EXISTS';
export type RowOutcome = 'CREATED' | 'EXISTS' | 'FAILED';

export interface ImportRowReport {
  /** The line in the file, header included: what a spreadsheet shows. */
  row: number;
  values: Record<string, string>;
  status: RowStatus;
  errors: ImportRowError[];
  /** Set when the batch is applied. */
  outcome?: RowOutcome;
  /** The domain error code when `outcome` is FAILED. */
  outcomeCode?: string;
  /** The customer, payment or reservation the row produced or matched. */
  entityId?: string;
}

export interface ImportReport {
  columns: string[];
  fileErrors: { code: FileErrorCode; column?: string }[];
  rows: ImportRowReport[];
}

export interface ImportLookups {
  /** Lower-cased email → customer id, for every CUSTOMER the file mentions. */
  customersByEmail: Map<string, string>;
  /** Lower-cased emails that belong to staff. */
  staffEmails: Set<string>;
  /** Trip slug → id and status, for every slug the file mentions. */
  tripsBySlug: Map<string, { id: string; status: string }>;
  /** `external_ref` values already in `payments`. */
  importedRefs: Set<string>;
  /** Today in the organization's timezone, `YYYY-MM-DD`. */
  today: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_METHODS = ['CASH', 'LEGACY', 'CARD', 'OXXO', 'SPEI'];
const NOT_ALLOWED_TRIP_STATUSES = ['DRAFT', 'CANCELLED'];

/** A real calendar date written `YYYY-MM-DD`, not after `today`. */
function validPastDate(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = DateTime.fromISO(value, { zone: 'utc' });
  return date.isValid && value <= today;
}

/** Splits the file into its header map and data rows, or explains why it cannot. */
export function readTable(
  type: ImportType,
  table: string[][]
): { columns: string[]; fileErrors: ImportReport['fileErrors']; records: { row: number; values: Record<string, string> }[] } {
  if (table.length === 0) return { columns: [], fileErrors: [{ code: 'EMPTY_FILE' }], records: [] };
  const header = (table[0] as string[]).map((cell) => cell.trim().toLowerCase());
  const missing = IMPORT_COLUMNS[type].filter(
    (column) => !OPTIONAL_COLUMNS[type].includes(column) && !header.includes(column)
  );
  const fileErrors: ImportReport['fileErrors'] = missing.map((column) => ({ code: 'MISSING_COLUMN', column }));
  if (table.length === 1) fileErrors.push({ code: 'NO_ROWS' });

  const records = table.slice(1).map((cells, index) => ({
    row: index + 2,
    values: Object.fromEntries(
      IMPORT_COLUMNS[type].map((column) => {
        const at = header.indexOf(column);
        return [column, at === -1 ? '' : (cells[at] ?? '').trim()];
      })
    ),
  }));
  return { columns: [...IMPORT_COLUMNS[type]], fileErrors, records };
}

function validateCustomer(values: Record<string, string>, lookups: ImportLookups): { errors: ImportRowError[]; existing?: string } {
  const errors: ImportRowError[] = [];
  const email = (values['email'] ?? '').toLowerCase();
  if (!values['full_name']) errors.push({ column: 'full_name', code: 'REQUIRED' });
  if (!email) errors.push({ column: 'email', code: 'REQUIRED' });
  else if (!EMAIL_PATTERN.test(email)) errors.push({ column: 'email', code: 'INVALID_EMAIL' });
  else if (lookups.staffEmails.has(email)) errors.push({ column: 'email', code: 'EMAIL_TAKEN' });
  const phone = values['phone'] ?? '';
  if (!phone) errors.push({ column: 'phone', code: 'REQUIRED' });
  else if (phone.replace(/\D/g, '').length < 7) errors.push({ column: 'phone', code: 'INVALID_PHONE' });
  const birthDate = values['birth_date'] ?? '';
  if (!birthDate) errors.push({ column: 'birth_date', code: 'REQUIRED' });
  else if (!validPastDate(birthDate, lookups.today)) errors.push({ column: 'birth_date', code: 'INVALID_DATE' });
  const locale = (values['locale'] ?? '').toLowerCase();
  if (locale && locale !== 'es' && locale !== 'en') errors.push({ column: 'locale', code: 'INVALID_LOCALE' });
  return { errors, existing: errors.length === 0 ? lookups.customersByEmail.get(email) : undefined };
}

function validatePayment(values: Record<string, string>, lookups: ImportLookups): { errors: ImportRowError[]; existing?: string } {
  const errors: ImportRowError[] = [];
  const email = (values['customer_email'] ?? '').toLowerCase();
  if (!email) errors.push({ column: 'customer_email', code: 'REQUIRED' });
  else if (!EMAIL_PATTERN.test(email)) errors.push({ column: 'customer_email', code: 'INVALID_EMAIL' });
  else if (!lookups.customersByEmail.has(email)) errors.push({ column: 'customer_email', code: 'UNKNOWN_CUSTOMER' });
  const slug = values['trip_slug'] ?? '';
  const trip = lookups.tripsBySlug.get(slug);
  if (!slug) errors.push({ column: 'trip_slug', code: 'REQUIRED' });
  else if (!trip) errors.push({ column: 'trip_slug', code: 'UNKNOWN_TRIP' });
  else if (NOT_ALLOWED_TRIP_STATUSES.includes(trip.status)) errors.push({ column: 'trip_slug', code: 'TRIP_NOT_ALLOWED' });
  const paidAt = values['paid_at'] ?? '';
  if (!paidAt) errors.push({ column: 'paid_at', code: 'REQUIRED' });
  else if (!validPastDate(paidAt, lookups.today)) errors.push({ column: 'paid_at', code: 'INVALID_DATE' });
  const amount = values['amount'] ?? '';
  if (!amount) errors.push({ column: 'amount', code: 'REQUIRED' });
  else {
    const cents = parsePesosToCents(amount);
    if (cents === null || cents <= 0) errors.push({ column: 'amount', code: 'INVALID_AMOUNT' });
  }
  const method = (values['method'] ?? '').toUpperCase();
  if (method && !PAYMENT_METHODS.includes(method)) errors.push({ column: 'method', code: 'UNKNOWN_METHOD' });
  const ref = values['external_ref'] ?? '';
  return { errors, existing: errors.length === 0 && ref && lookups.importedRefs.has(ref) ? ref : undefined };
}

/**
 * Validates every row. A row is `INVALID` with every error it has (column and
 * code), `EXISTS` when it is already in the system -- a customer's email, a
 * payment's `external_ref` -- which is not an error, or `VALID`. Duplicates
 * inside the file (same email, same `external_ref`) are errors on every
 * occurrence after the first.
 */
export function validateRows(
  type: ImportType,
  records: { row: number; values: Record<string, string> }[],
  lookups: ImportLookups
): ImportRowReport[] {
  const seen = new Set<string>();
  return records.map(({ row, values }) => {
    const { errors, existing } = type === 'CUSTOMERS' ? validateCustomer(values, lookups) : validatePayment(values, lookups);
    const key =
      type === 'CUSTOMERS'
        ? { column: 'email', value: (values['email'] ?? '').toLowerCase() }
        : { column: 'external_ref', value: values['external_ref'] ?? '' };
    if (key.value) {
      if (seen.has(key.value)) errors.push({ column: key.column, code: 'DUPLICATE_IN_FILE' });
      seen.add(key.value);
    }
    const status: RowStatus = errors.length > 0 ? 'INVALID' : existing ? 'EXISTS' : 'VALID';
    return { row, values, status, errors, ...(status === 'EXISTS' && type === 'CUSTOMERS' ? { entityId: existing } : {}) };
  });
}
