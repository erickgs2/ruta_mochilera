import { PdfLibReceiptRenderer, type ReceiptRenderer } from '@rm/receipts';
import type { Result } from '@rm/shared-utils';
import { problemResponse } from './http/problem';

let cached: ReceiptRenderer | undefined;

/** The PDF renderer receipt downloads use when a PDF was never generated yet. */
export function receiptRenderer(): ReceiptRenderer {
  cached ??= new PdfLibReceiptRenderer();
  return cached;
}

/** Test-only seam, mirroring `setStorage`. */
export function setReceiptRenderer(renderer: ReceiptRenderer | undefined): void {
  cached = renderer;
}

/**
 * Answers a receipt download with the PDF itself rather than JSON. Private
 * and never cached: a receipt is personal and a shared cache must not keep
 * it.
 */
export function pdfResponse(result: Result<{ receipt: { data: { receiptNumber: string } }; pdf: Buffer }>): Response {
  if (!result.ok) return problemResponse(result.error);
  return new Response(new Uint8Array(result.value.pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${result.value.receipt.data.receiptNumber}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}
