import { z } from 'zod';
import { uuidSchema } from './common';

export const importTypeSchema = z.enum(['CUSTOMERS', 'PAYMENTS']);
export const importStatusSchema = z.enum(['VALIDATED', 'APPLYING', 'APPLIED', 'FAILED']);

/**
 * The body of `POST /api/v1/admin/imports`: the CSV's text as read by the
 * browser. The 5,000-row / 5 MB limit is the domain's (`IMPORT_TOO_LARGE`,
 * 413); this bound only keeps a request from being absurd.
 */
export const validateImportRequestSchema = z.object({
  type: importTypeSchema,
  fileName: z.string().trim().min(1).max(200),
  content: z.string().max(12_000_000),
  sendEmails: z.boolean().default(false),
});

export const importRowSchema = z.object({
  row: z.number().int(),
  values: z.record(z.string(), z.string()),
  status: z.enum(['VALID', 'INVALID', 'EXISTS']),
  errors: z.array(z.object({ column: z.string(), code: z.string() })),
  outcome: z.enum(['CREATED', 'EXISTS', 'FAILED']).optional(),
  outcomeCode: z.string().optional(),
  entityId: z.string().optional(),
});

export const importReportSchema = z.object({
  columns: z.array(z.string()),
  fileErrors: z.array(z.object({ code: z.string(), column: z.string().optional() })),
  rows: z.array(importRowSchema),
});

/** A batch in the list, matching `ImportBatchSummaryDto`. */
export const importBatchSummarySchema = z.object({
  id: uuidSchema,
  type: importTypeSchema,
  fileName: z.string(),
  status: importStatusSchema,
  rowsTotal: z.number().int(),
  rowsOk: z.number().int(),
  rowsFailed: z.number().int(),
  sendEmails: z.boolean(),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});

export const importBatchSchema = importBatchSummarySchema.extend({ report: importReportSchema });

export type ValidateImportRequest = z.infer<typeof validateImportRequestSchema>;
export type ImportBatchSummaryContract = z.infer<typeof importBatchSummarySchema>;
export type ImportBatchContract = z.infer<typeof importBatchSchema>;
export type ImportRowContract = z.infer<typeof importRowSchema>;
