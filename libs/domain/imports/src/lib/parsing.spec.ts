import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv';
import { parsePesosToCents } from './money';
import { exampleRow, IMPORT_COLUMNS, importTemplate } from './templates';
import { readTable, validateRows, type ImportLookups } from './validate-rows';

describe('parseCsv', () => {
  it('reads quoted fields with commas, escaped quotes and line breaks, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n"Peña, María","dice ""hola""","línea 1\nlínea 2"\r\n\r\n';

    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['Peña, María', 'dice "hola"', 'línea 1\nlínea 2'],
    ]);
  });

  it('round-trips what toCsv writes', () => {
    const rows = [['x', 'y'], ['con, coma', 'con "comillas"']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('parsePesosToCents', () => {
  it('converts pesos to exact cents without floating point', () => {
    expect(parsePesosToCents('1500.10')).toBe(150_010);
    expect(parsePesosToCents('1500.1')).toBe(150_010);
    expect(parsePesosToCents('1500')).toBe(150_000);
    expect(parsePesosToCents('$1,500.99')).toBe(150_099);
    expect(parsePesosToCents('0.29')).toBe(29);
  });

  it('refuses what is not an amount', () => {
    for (const text of ['', 'abc', '1.234', '-5', '1,50', '12.3.4', '1 500']) {
      expect(parsePesosToCents(text)).toBeNull();
    }
  });
});

describe('templates', () => {
  it('have exactly the columns of the spec', () => {
    expect(IMPORT_COLUMNS.CUSTOMERS).toEqual(['full_name', 'email', 'phone', 'birth_date', 'locale']);
    expect(IMPORT_COLUMNS.PAYMENTS).toEqual(['customer_email', 'trip_slug', 'paid_at', 'amount', 'method', 'external_ref', 'notes']);
  });

  it('carry an example row that validates without errors', () => {
    const lookups: ImportLookups = {
      customersByEmail: new Map([['maria.pena@example.com', 'c1']]),
      staffEmails: new Set(),
      tripsBySlug: new Map([['real-de-catorce-2027', { id: 't1', status: 'PUBLISHED' }]]),
      importedRefs: new Set(),
      today: '2026-12-31',
    };
    for (const type of ['CUSTOMERS', 'PAYMENTS'] as const) {
      const { records, fileErrors } = readTable(type, parseCsv(importTemplate(type).content));
      expect(fileErrors).toEqual([]);
      expect(records.map((record) => record.values)).toEqual([exampleRow(type)]);
      const [row] = validateRows(type, records, { ...lookups, customersByEmail: type === 'CUSTOMERS' ? new Map() : lookups.customersByEmail });
      expect(row?.errors).toEqual([]);
    }
  });
});

describe('validateRows', () => {
  const lookups: ImportLookups = {
    customersByEmail: new Map([['ya@example.com', 'existing-id']]),
    staffEmails: new Set(['admin@agency.test']),
    tripsBySlug: new Map([
      ['oaxaca', { id: 't1', status: 'COMPLETED' }],
      ['borrador', { id: 't2', status: 'DRAFT' }],
    ]),
    importedRefs: new Set(['REF-OLD']),
    today: '2026-10-07',
  };

  it('reports every customer error with its row, column and code, and EXISTS for a known email', () => {
    const table = parseCsv(
      [
        'full_name,email,phone,birth_date,locale',
        ',no-es-correo,12,1990-02-30,fr',
        'Ana,ana@example.com,3521008079,2030-01-01,',
        'Ya Existe,YA@example.com,3521008079,1990-01-01,es',
        'Ana Otra,ana@example.com,3521008079,1990-01-01,en',
        'Admin,admin@agency.test,3521008079,1990-01-01,',
      ].join('\n')
    );
    const rows = validateRows('CUSTOMERS', readTable('CUSTOMERS', table).records, lookups);

    expect(rows[0]).toMatchObject({
      row: 2,
      status: 'INVALID',
      errors: [
        { column: 'full_name', code: 'REQUIRED' },
        { column: 'email', code: 'INVALID_EMAIL' },
        { column: 'phone', code: 'INVALID_PHONE' },
        { column: 'birth_date', code: 'INVALID_DATE' },
        { column: 'locale', code: 'INVALID_LOCALE' },
      ],
    });
    expect(rows[1]).toMatchObject({ row: 3, status: 'INVALID', errors: [{ column: 'birth_date', code: 'INVALID_DATE' }] });
    expect(rows[2]).toMatchObject({ row: 4, status: 'EXISTS', errors: [], entityId: 'existing-id' });
    expect(rows[3]).toMatchObject({ row: 5, status: 'INVALID', errors: [{ column: 'email', code: 'DUPLICATE_IN_FILE' }] });
    expect(rows[4]).toMatchObject({ status: 'INVALID', errors: [{ column: 'email', code: 'EMAIL_TAKEN' }] });
  });

  it('reports payment errors, and EXISTS for an external_ref already imported', () => {
    const table = parseCsv(
      [
        'customer_email,trip_slug,paid_at,amount,method,external_ref,notes',
        'nadie@example.com,nope,2026-13-01,abc,CHEQUE,,',
        'ya@example.com,borrador,2026-10-01,100,,,',
        'ya@example.com,oaxaca,2026-10-01,100,,REF-OLD,',
        'ya@example.com,oaxaca,2026-10-01,100,cash,REF-1,',
        'ya@example.com,oaxaca,2026-10-02,100,,REF-1,',
      ].join('\n')
    );
    const rows = validateRows('PAYMENTS', readTable('PAYMENTS', table).records, lookups);

    expect(rows[0]?.errors).toEqual([
      { column: 'customer_email', code: 'UNKNOWN_CUSTOMER' },
      { column: 'trip_slug', code: 'UNKNOWN_TRIP' },
      { column: 'paid_at', code: 'INVALID_DATE' },
      { column: 'amount', code: 'INVALID_AMOUNT' },
      { column: 'method', code: 'UNKNOWN_METHOD' },
    ]);
    expect(rows[1]?.errors).toEqual([{ column: 'trip_slug', code: 'TRIP_NOT_ALLOWED' }]);
    expect(rows[2]?.status).toBe('EXISTS');
    expect(rows[3]?.status).toBe('VALID');
    expect(rows[4]?.errors).toEqual([{ column: 'external_ref', code: 'DUPLICATE_IN_FILE' }]);
  });

  it('names a missing required column as a file error', () => {
    expect(readTable('CUSTOMERS', parseCsv('full_name,email\nAna,ana@example.com')).fileErrors).toEqual([
      { code: 'MISSING_COLUMN', column: 'phone' },
      { code: 'MISSING_COLUMN', column: 'birth_date' },
    ]);
  });
});
