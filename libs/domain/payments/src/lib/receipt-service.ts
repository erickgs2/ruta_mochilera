import { randomUUID } from 'node:crypto';
import type { Db, DbTransactionClient } from '@rm/db';
import type { EmailAttachment, EmailMessage } from '@rm/email';
import { SEND_RECEIPT_JOB, type SendReceiptPayload } from '@rm/jobs';
import type { ReceiptData, ReceiptRenderer } from '@rm/receipts';
import { organizationProfile, organizationTimeZone } from '@rm/domain-settings';
import { fail, formatMoney, ok, type Result } from '@rm/shared-utils';
import type { StorageProvider } from '@rm/storage';
import { fromPrisma, type PgBoss } from 'pg-boss';

/** The one pg-boss capability enqueuing a receipt needs. */
export type ReceiptQueue = Pick<PgBoss, 'send'>;

/** Everything sending a receipt needs, beyond what the PDF prints. */
export interface LoadedReceipt {
  data: ReceiptData;
  paymentId: string;
  customerEmail: string;
  receiptKey: string | null;
  receiptSentAt: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Enqueues the receipt of a payment that just became SUCCEEDED, **on the
 * caller's transaction** (the outbox pattern of `notifications.md`, Ruling
 * 11): if the payment rolls back, so does the job. Callers that capture
 * history silently simply do not call it.
 */
export async function enqueueReceipt(tx: DbTransactionClient, queue: ReceiptQueue, paymentId: string): Promise<void> {
  const payload: SendReceiptPayload = { paymentId };
  await queue.send(SEND_RECEIPT_JOB, payload, { db: fromPrisma(tx) });
}

/**
 * Staff ask for a receipt to be sent again (or for the first time, for a
 * payment captured silently). Only a payment that has a receipt number can.
 */
export async function requestReceiptResend(db: Db, queue: ReceiptQueue, paymentId: string): Promise<Result<null>> {
  if (!UUID_PATTERN.test(paymentId)) return fail('NOT_FOUND');
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { receiptNumber: true } });
  if (!payment?.receiptNumber) return fail('NOT_FOUND');
  const payload: SendReceiptPayload = { paymentId, resend: true };
  await queue.send(SEND_RECEIPT_JOB, payload);
  return ok(null);
}

/**
 * Gathers what a receipt prints. The balance is the snapshot written with
 * the receipt number (`receipt_total_cents`, `receipt_paid_cents`); for a
 * payment confirmed before those columns existed it is rebuilt from the
 * SUCCEEDED payments made up to this one.
 *
 * `NOT_FOUND` for an unknown payment and for one without a receipt number
 * (not SUCCEEDED): there is no receipt to show.
 */
export async function loadReceipt(db: Db | DbTransactionClient, paymentId: string): Promise<Result<LoadedReceipt>> {
  if (!UUID_PATTERN.test(paymentId)) return fail('NOT_FOUND');
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      reservation: {
        include: {
          customer: { include: { user: { select: { email: true, locale: true } } } },
          trip: { include: { translations: { select: { locale: true, name: true } } } },
        },
      },
    },
  });
  if (!payment || payment.status !== 'SUCCEEDED' || !payment.receiptNumber || !payment.paidAt) {
    return fail('NOT_FOUND');
  }

  const { reservation } = payment;
  const locale = reservation.customer.user.locale;
  const translation =
    reservation.trip.translations.find((candidate) => candidate.locale === locale) ?? reservation.trip.translations[0];

  let paidCents = payment.receiptPaidCents;
  if (paidCents === null) {
    const sum = await db.payment.aggregate({
      where: { reservationId: reservation.id, status: 'SUCCEEDED', paidAt: { lte: payment.paidAt } },
      _sum: { amountCents: true },
    });
    paidCents = sum._sum.amountCents ?? payment.amountCents;
  }
  const totalCents = payment.receiptTotalCents ?? reservation.totalPriceCents;

  return ok({
    paymentId: payment.id,
    customerEmail: reservation.customer.user.email,
    receiptKey: payment.receiptKey,
    receiptSentAt: payment.receiptSentAt,
    data: {
      locale,
      timeZone: await organizationTimeZone(db),
      organization: await organizationProfile(db),
      receiptNumber: payment.receiptNumber,
      paidAt: payment.paidAt,
      customerName: reservation.customer.fullName,
      tripName: translation?.name ?? reservation.trip.slug,
      departureDate: reservation.trip.departureDate,
      returnDate: reservation.trip.returnDate,
      reservationCode: reservation.code,
      amountCents: payment.amountCents,
      method: payment.method,
      totalCents,
      paidCents,
      balanceCents: Math.max(0, totalCents - paidCents),
    },
  });
}

/**
 * Where a receipt's PDF lives: `receipts/{year}/{number}-{random}.pdf`.
 *
 * Receipt numbers are sequential and therefore guessable, and a receipt is
 * private: the random suffix keeps the key unguessable even if a storage
 * bucket were ever exposed more broadly than intended. The local file route
 * also refuses the `receipts/` prefix outright; receipts are only served
 * through routes that check who is asking. Anything outside the storage key
 * charset (a prefix with a space, say) is replaced.
 */
export function receiptStorageKey(receiptNumber: string): string {
  const parts = receiptNumber.split('-');
  const year = parts.length >= 3 ? parts[parts.length - 2] : 'other';
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
  return `receipts/${safe(year)}/${safe(receiptNumber)}-${randomUUID()}.pdf`;
}

/**
 * The receipt's PDF: read back when it was already generated, otherwise
 * rendered once, stored and recorded in `receipt_key`. **Never regenerated**:
 * what a receipt says does not change when the reservation does later.
 */
export async function ensureReceiptPdf(
  db: Db,
  storage: StorageProvider,
  renderer: ReceiptRenderer,
  paymentId: string
): Promise<Result<{ receipt: LoadedReceipt; pdf: Buffer }>> {
  const loaded = await loadReceipt(db, paymentId);
  if (!loaded.ok) return loaded;
  const receipt = loaded.value;

  if (receipt.receiptKey && (await storage.exists(receipt.receiptKey))) {
    return ok({ receipt, pdf: await storage.get(receipt.receiptKey) });
  }

  const pdf = Buffer.from(await renderer.render(receipt.data));
  const key = receiptStorageKey(receipt.data.receiptNumber);
  await storage.put(key, pdf, 'application/pdf');
  // Conditional: two jobs (or a job and a download) generating at once must
  // not leave two different PDFs for one receipt. The loser drops its copy
  // and serves the winner's.
  const claimed = await db.payment.updateMany({
    where: { id: paymentId, OR: [{ receiptKey: null }, { receiptKey: receipt.receiptKey }] },
    data: { receiptKey: key },
  });
  if (claimed.count === 0) {
    await storage.delete(key);
    const winner = await db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { receiptKey: true } });
    if (winner.receiptKey) return ok({ receipt: { ...receipt, receiptKey: winner.receiptKey }, pdf: await storage.get(winner.receiptKey) });
  }
  return ok({ receipt: { ...receipt, receiptKey: key }, pdf });
}

/**
 * A customer downloads one of their own receipts. Another customer's
 * payment answers `RESERVATION_NOT_OWNED` (404), exactly like an unknown one
 * from the outside -- see `RESERVATION_NOT_OWNED` in `STATUS_BY_CODE`.
 */
export async function ensureReceiptPdfForCustomer(
  db: Db,
  storage: StorageProvider,
  renderer: ReceiptRenderer,
  paymentId: string,
  customerId: string
): Promise<Result<{ receipt: LoadedReceipt; pdf: Buffer }>> {
  if (!UUID_PATTERN.test(paymentId)) return fail('RESERVATION_NOT_OWNED');
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { reservation: { select: { customerId: true } } },
  });
  if (!payment || payment.reservation.customerId !== customerId) return fail('RESERVATION_NOT_OWNED');
  return ensureReceiptPdf(db, storage, renderer, paymentId);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The email that carries a receipt, in the customer's language. */
export function receiptEmailMessage(receipt: LoadedReceipt, pdf: Uint8Array): EmailMessage {
  const { data } = receipt;
  const amount = formatMoney(data.amountCents, data.locale);
  const balance = formatMoney(data.balanceCents, data.locale);
  const lines =
    data.locale === 'es'
      ? {
          subject: `Tu recibo de pago ${data.receiptNumber}`,
          body: [
            `Hola, ${data.customerName}:`,
            `Recibimos tu pago de ${amount} para ${data.tripName} (reserva ${data.reservationCode}).`,
            `Tu saldo pendiente después de este pago es de ${balance}.`,
            'Adjuntamos tu recibo en PDF. También puedes descargarlo desde la app, en tu historial de pagos.',
            `— ${data.organization.name}`,
          ],
        }
      : {
          subject: `Your payment receipt ${data.receiptNumber}`,
          body: [
            `Hello ${data.customerName},`,
            `We received your payment of ${amount} for ${data.tripName} (reservation ${data.reservationCode}).`,
            `Your balance due after this payment is ${balance}.`,
            'Your receipt is attached as a PDF. You can also download it from the app, in your payment history.',
            `— ${data.organization.name}`,
          ],
        };
  const attachment: EmailAttachment = {
    filename: `${data.receiptNumber}.pdf`,
    contentType: 'application/pdf',
    content: pdf,
  };
  return {
    to: receipt.customerEmail,
    subject: lines.subject,
    text: lines.body.join('\n\n'),
    html: lines.body.map((line) => `<p>${escapeHtml(line)}</p>`).join(''),
    attachments: [attachment],
  };
}

/**
 * Stamps `receipt_sent_at` once the provider accepted the email. A separate
 * step so the PDF is stored even when sending fails and the job retries.
 */
export async function markReceiptSent(db: Db, paymentId: string, sentAt: Date = new Date()): Promise<void> {
  await db.payment.update({ where: { id: paymentId }, data: { receiptSentAt: sentAt } });
}
