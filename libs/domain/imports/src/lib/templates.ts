import { toCsv } from './csv';

export type ImportType = 'CUSTOMERS' | 'PAYMENTS';

/**
 * The columns of each template (spec §5.8), in order. Headers are stable
 * English names: the panel translates them, the file never changes.
 */
export const IMPORT_COLUMNS: Record<ImportType, readonly string[]> = {
  CUSTOMERS: ['full_name', 'email', 'phone', 'birth_date', 'locale'],
  PAYMENTS: ['customer_email', 'trip_slug', 'paid_at', 'amount', 'method', 'external_ref', 'notes'],
};

/** Columns a file may leave out entirely; every other one must be present. */
export const OPTIONAL_COLUMNS: Record<ImportType, readonly string[]> = {
  CUSTOMERS: ['locale'],
  PAYMENTS: ['method', 'external_ref', 'notes'],
};

const EXAMPLE_ROWS: Record<ImportType, string[]> = {
  CUSTOMERS: ['María Peña Núñez', 'maria.pena@example.com', '352 100 80 79', '1990-05-17', 'es'],
  PAYMENTS: ['maria.pena@example.com', 'real-de-catorce-2027', '2026-11-03', '1500.00', 'CASH', 'LIBRETA-3-12', 'Anticipo'],
};

/** A downloadable template: the header row and one example row, UTF-8 with BOM so Excel opens accents right. */
export function importTemplate(type: ImportType): { fileName: string; content: string } {
  return {
    fileName: type === 'CUSTOMERS' ? 'plantilla-clientes.csv' : 'plantilla-pagos.csv',
    content: `﻿${toCsv([[...IMPORT_COLUMNS[type]], EXAMPLE_ROWS[type]])}`,
  };
}

/** The example row as values, for tests and documentation. */
export function exampleRow(type: ImportType): Record<string, string> {
  const columns = IMPORT_COLUMNS[type];
  return Object.fromEntries(columns.map((column, index) => [column, EXAMPLE_ROWS[type][index] ?? '']));
}
