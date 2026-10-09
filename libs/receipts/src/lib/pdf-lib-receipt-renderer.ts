import fontkit from '@pdf-lib/fontkit';
import { formatMoney } from '@rm/shared-utils';
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { POPPINS_REGULAR_WOFF, POPPINS_SEMIBOLD_WOFF, RECEIPT_LOGO_PNG } from './embedded-assets.generated';
import type { ReceiptData, ReceiptLocale, ReceiptPaymentMethod, ReceiptRenderer } from './receipt-renderer';

/**
 * The brand palette from `docs/brand.md`, as PDF colours. A PDF has no CSS,
 * so the `--rm-*` tokens are mirrored here by value; keep them in step with
 * `libs/ui/src/styles/_brand.scss`.
 */
const INK = hex('#2a2924'); // --rm-ink
const INK_SOFT = hex('#57544a'); // --rm-ink-soft
const YELLOW = hex('#f9d423'); // --rm-yellow
const CREAM = hex('#fcf6da'); // --rm-cream
const LINE = hex('#e8e0c4'); // --rm-line

const PAGE_WIDTH = 612; // US Letter, the paper size used in Mexico
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

interface Labels {
  title: string;
  paidAt: string;
  reservation: string;
  customer: string;
  trip: string;
  tripDates: string;
  method: string;
  amount: string;
  /** The line under the amount when part of the payment became credit; takes the formatted money. */
  credited: (money: string) => string;
  balanceHeading: string;
  total: string;
  paid: string;
  balance: string;
  thanks: string;
  notFiscal: string;
  methods: Record<ReceiptPaymentMethod, string>;
}

const LABELS: Record<ReceiptLocale, Labels> = {
  es: {
    title: 'RECIBO DE PAGO',
    paidAt: 'Fecha de pago',
    reservation: 'Reserva',
    customer: 'Cliente',
    trip: 'Viaje',
    tripDates: 'Fechas del viaje',
    method: 'Forma de pago',
    amount: 'Monto recibido',
    credited: (money) => `De este pago, ${money} quedó como saldo a favor`,
    balanceHeading: 'Estado de cuenta al momento de este pago',
    total: 'Precio total',
    paid: 'Pagado a la fecha (incluye este pago)',
    balance: 'Saldo pendiente',
    thanks: '¡Gracias por viajar con nosotros!',
    notFiscal: 'Este recibo ampara el pago indicado. No es un comprobante fiscal (CFDI).',
    methods: {
      CARD: 'Tarjeta',
      OXXO: 'Efectivo en OXXO',
      SPEI: 'Transferencia SPEI',
      CASH: 'Efectivo',
      LEGACY: 'Pago registrado',
      CREDIT: 'Saldo a favor',
    },
  },
  en: {
    title: 'PAYMENT RECEIPT',
    paidAt: 'Payment date',
    reservation: 'Reservation',
    customer: 'Customer',
    trip: 'Trip',
    tripDates: 'Trip dates',
    method: 'Payment method',
    amount: 'Amount received',
    credited: (money) => `${money} of this payment became account credit`,
    balanceHeading: 'Account status at the time of this payment',
    total: 'Total price',
    paid: 'Paid to date (including this payment)',
    balance: 'Balance due',
    thanks: 'Thank you for travelling with us!',
    notFiscal: 'This receipt covers the payment shown. It is not a tax invoice (CFDI).',
    methods: {
      CARD: 'Card',
      OXXO: 'Cash at OXXO',
      SPEI: 'SPEI transfer',
      CASH: 'Cash',
      LEGACY: 'Recorded payment',
      CREDIT: 'Account credit',
    },
  },
};

function hex(value: string): RGB {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function intlLocale(locale: ReceiptLocale): string {
  return locale === 'es' ? 'es-MX' : 'en-US';
}

function formatPaidAt(data: ReceiptData): string {
  return new Intl.DateTimeFormat(intlLocale(data.locale), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: data.timeZone,
  }).format(data.paidAt);
}

function formatTripDates(data: ReceiptData): string {
  // Calendar dates are stored as UTC midnight: formatting them in UTC keeps
  // 1 December as 1 December in every timezone.
  return new Intl.DateTimeFormat(intlLocale(data.locale), { dateStyle: 'long', timeZone: 'UTC' }).formatRange(
    data.departureDate,
    data.returnDate
  );
}

/** Splits `text` into lines no wider than `width` at `size`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface Fonts {
  regular: PDFFont;
  semibold: PDFFont;
}

/** Draws wrapped text from `y` downwards and returns the y below it. */
function drawLines(
  page: PDFPage,
  text: string,
  options: { x: number; y: number; width: number; font: PDFFont; size: number; color: RGB; lineGap?: number }
): number {
  let y = options.y;
  for (const line of wrap(text, options.font, options.size, options.width)) {
    page.drawText(line, { x: options.x, y, size: options.size, font: options.font, color: options.color });
    y -= options.size + (options.lineGap ?? 4);
  }
  return y;
}

function drawRightAligned(page: PDFPage, text: string, right: number, y: number, font: PDFFont, size: number, color: RGB) {
  page.drawText(text, { x: right - font.widthOfTextAtSize(text, size), y, size, font, color });
}

/**
 * The production receipt: one US Letter page with the agency's identity, the
 * payment, and the reservation's balance at that moment. Poppins is embedded
 * (latin subset, which covers Spanish accents, «ñ» and «¡¿»).
 */
export class PdfLibReceiptRenderer implements ReceiptRenderer {
  async render(data: ReceiptData): Promise<Uint8Array> {
    const labels = LABELS[data.locale];
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const fonts: Fonts = {
      regular: await pdf.embedFont(Buffer.from(POPPINS_REGULAR_WOFF, 'base64'), { subset: true }),
      semibold: await pdf.embedFont(Buffer.from(POPPINS_SEMIBOLD_WOFF, 'base64'), { subset: true }),
    };
    const logo = await pdf.embedPng(Buffer.from(RECEIPT_LOGO_PNG, 'base64'));

    pdf.setTitle(`${labels.title} ${data.receiptNumber}`);
    pdf.setAuthor(data.organization.name);
    pdf.setLanguage(intlLocale(data.locale));
    pdf.setCreator(data.organization.name);
    pdf.setProducer(data.organization.name);

    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const right = PAGE_WIDTH - MARGIN;
    let y = PAGE_HEIGHT - MARGIN;

    // Header: logo, agency and receipt number.
    const logoSize = 64;
    page.drawImage(logo, { x: MARGIN, y: y - logoSize, width: logoSize, height: logoSize });
    const headerX = MARGIN + logoSize + 14;
    const headerWidth = 260;
    page.drawText(data.organization.name, { x: headerX, y: y - 18, size: 16, font: fonts.semibold, color: INK });
    let headerY = drawLines(page, data.organization.address, {
      x: headerX,
      y: y - 34,
      width: headerWidth,
      font: fonts.regular,
      size: 8.5,
      color: INK_SOFT,
      lineGap: 3,
    });
    for (const line of [data.organization.phone, data.organization.website].filter(Boolean)) {
      page.drawText(line, { x: headerX, y: headerY, size: 8.5, font: fonts.regular, color: INK_SOFT });
      headerY -= 11.5;
    }

    drawRightAligned(page, labels.title, right, y - 14, fonts.semibold, 10, INK_SOFT);
    drawRightAligned(page, data.receiptNumber, right, y - 36, fonts.semibold, 18, INK);

    y = Math.min(y - logoSize, headerY) - 16;
    page.drawRectangle({ x: MARGIN, y, width: CONTENT_WIDTH, height: 4, color: YELLOW });
    y -= 28;

    // Who, what and when, in two columns.
    const column = CONTENT_WIDTH / 2;
    const fields: [string, string][] = [
      [labels.paidAt, formatPaidAt(data)],
      [labels.reservation, data.reservationCode],
      [labels.customer, data.customerName],
      [labels.method, labels.methods[data.method]],
      [labels.trip, data.tripName],
      [labels.tripDates, formatTripDates(data)],
    ];
    for (let i = 0; i < fields.length; i += 2) {
      let rowBottom = y;
      for (let j = 0; j < 2; j++) {
        const field = fields[i + j];
        if (!field) continue;
        const x = MARGIN + j * column;
        page.drawText(field[0], { x, y, size: 8.5, font: fonts.regular, color: INK_SOFT });
        const bottom = drawLines(page, field[1], {
          x,
          y: y - 15,
          width: column - 16,
          font: fonts.semibold,
          size: 11,
          color: INK,
        });
        rowBottom = Math.min(rowBottom, bottom);
      }
      y = rowBottom - 10;
    }

    // The amount, on a cream panel.
    const panelHeight = data.creditedCents > 0 ? 98 : 74;
    y -= 6;
    page.drawRectangle({ x: MARGIN, y: y - panelHeight, width: CONTENT_WIDTH, height: panelHeight, color: CREAM });
    page.drawText(labels.amount, { x: MARGIN + 20, y: y - 26, size: 10, font: fonts.regular, color: INK_SOFT });
    page.drawText(formatMoney(data.amountCents, data.locale), {
      x: MARGIN + 20,
      y: y - 56,
      size: 26,
      font: fonts.semibold,
      color: INK,
    });
    if (data.creditedCents > 0) {
      page.drawText(labels.credited(formatMoney(data.creditedCents, data.locale)), {
        x: MARGIN + 20,
        y: y - 80,
        size: 10,
        font: fonts.regular,
        color: INK_SOFT,
      });
    }
    y -= panelHeight + 30;

    // The balance as it stood right after this payment.
    page.drawText(labels.balanceHeading, { x: MARGIN, y, size: 10, font: fonts.semibold, color: INK });
    y -= 10;
    const rows: [string, number, boolean][] = [
      [labels.total, data.totalCents, false],
      [labels.paid, data.paidCents, false],
      [labels.balance, data.balanceCents, true],
    ];
    for (const [label, cents, strong] of rows) {
      page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.75, color: LINE });
      y -= 20;
      const font = strong ? fonts.semibold : fonts.regular;
      page.drawText(label, { x: MARGIN, y, size: 10.5, font, color: INK });
      drawRightAligned(page, formatMoney(cents, data.locale), right, y, font, 10.5, INK);
      y -= 10;
    }
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.75, color: LINE });

    // Footer.
    page.drawRectangle({ x: MARGIN, y: MARGIN + 30, width: 36, height: 3, color: YELLOW });
    page.drawText(labels.thanks, { x: MARGIN, y: MARGIN + 14, size: 10, font: fonts.semibold, color: INK });
    page.drawText(labels.notFiscal, { x: MARGIN, y: MARGIN, size: 8, font: fonts.regular, color: INK_SOFT });

    return pdf.save();
  }
}
