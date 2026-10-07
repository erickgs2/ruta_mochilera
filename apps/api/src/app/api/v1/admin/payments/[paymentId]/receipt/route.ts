import { ensureReceiptPdf } from '@rm/domain-payments';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { pdfResponse, receiptRenderer } from '../../../../../../../lib/receipt-renderer';
import { storage } from '../../../../../../../lib/storage';

/**
 * Staff download a payment's receipt PDF (Phase 2B, §5.4). Generated and
 * stored on first request if the job has not done it yet (a payment captured
 * silently, say); never regenerated afterwards.
 */
export const GET = route({
  permission: 'payment.view',
  handler: async ({ params }) =>
    ensureReceiptPdf(db(), storage(), receiptRenderer(), params['paymentId'] as string),
  respond: pdfResponse,
});
