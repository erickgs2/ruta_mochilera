import { ensureReceiptPdfForCustomer } from '@rm/domain-payments';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';
import { pdfResponse, receiptRenderer } from '../../../../../../lib/receipt-renderer';
import { storage } from '../../../../../../lib/storage';

/** A customer downloads the receipt of one of their own payments (Phase 2B, §5.4). */
export const GET = route({
  handler: async ({ actor, params }) =>
    ensureReceiptPdfForCustomer(db(), storage(), receiptRenderer(), params['paymentId'] as string, actor.userId),
  respond: pdfResponse,
});
