import type { Db } from '@rm/db';
import type { EmailProvider } from '@rm/email';
import { ensureReceiptPdf, markReceiptSent, receiptEmailMessage } from '@rm/domain-payments';
import type { SendReceiptPayload } from '@rm/jobs';
import type { ReceiptRenderer } from '@rm/receipts';
import { ok, type Result } from '@rm/shared-utils';
import type { StorageProvider } from '@rm/storage';

export type SendReceiptOutcome = 'SENT' | 'ALREADY_SENT' | 'NO_RECEIPT';

/**
 * The `SEND_RECEIPT` job (Phase 2B, business rule 5.4): makes sure the
 * payment's PDF exists -- rendered once, stored, never regenerated -- then
 * emails it as an attachment to the customer's **current** address and
 * stamps `receipt_sent_at`.
 *
 * - **Idempotent.** A receipt already sent is not sent again, unless staff
 *   asked for a resend (`payload.resend`).
 * - **A provider failure is a failed `Result`**, with the PDF already stored
 *   and `receipt_sent_at` still null; `main.ts` turns it into a thrown error
 *   so pg-boss retries the job.
 * - A payment that has no receipt (unknown, or not SUCCEEDED) is skipped:
 *   there is nothing to send and retrying would not change that.
 */
export async function sendReceipt(
  db: Db,
  storage: StorageProvider,
  renderer: ReceiptRenderer,
  email: EmailProvider,
  payload: SendReceiptPayload
): Promise<Result<SendReceiptOutcome>> {
  const payment = await db.payment.findUnique({
    where: { id: payload.paymentId },
    select: { receiptSentAt: true },
  });
  if (!payment) return ok('NO_RECEIPT');
  if (payment.receiptSentAt && !payload.resend) return ok('ALREADY_SENT');

  const ensured = await ensureReceiptPdf(db, storage, renderer, payload.paymentId);
  if (!ensured.ok) return ok('NO_RECEIPT');

  const sent = await email.send(receiptEmailMessage(ensured.value.receipt, ensured.value.pdf));
  if (!sent.ok) return sent;

  await markReceiptSent(db, payload.paymentId);
  return ok('SENT');
}
