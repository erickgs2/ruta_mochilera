import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfLibReceiptRenderer } from './pdf-lib-receipt-renderer';
import type { ReceiptData } from './receipt-renderer';

const BASE: ReceiptData = {
  locale: 'es',
  timeZone: 'America/Mexico_City',
  organization: {
    name: 'La Ruta Mochilera',
    address: 'Casa Mochilera, Mariano Jiménez no. 551 B, Col. Jardines del Carmen, La Piedad, Mich.',
    phone: '352 100 80 79 / 352 144 23 28',
    website: 'www.fb.com/larutamochilera',
  },
  receiptNumber: 'RM-2027-000042',
  // 23:30 on 31 December 2026 in Mexico City.
  paidAt: new Date('2027-01-01T05:30:00Z'),
  customerName: 'María Peña Núñez',
  tripName: 'Real de Catorce',
  departureDate: new Date('2027-03-12T00:00:00Z'),
  returnDate: new Date('2027-03-14T00:00:00Z'),
  reservationCode: 'RM-7K2Q9X',
  amountCents: 150_000,
  method: 'CASH',
  totalCents: 500_000,
  paidCents: 250_000,
  balanceCents: 250_000,
  creditedCents: 0,
};

async function textOf(pdf: Uint8Array): Promise<string> {
  const document = await getDocument({ data: pdf.slice(), useSystemFonts: false }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  return content.items.map((item) => ('str' in item ? item.str : '')).join('\n');
}

describe('PdfLibReceiptRenderer', () => {
  const renderer = new PdfLibReceiptRenderer();

  it('renders a PDF with the receipt number, the customer, the amount and the agency', async () => {
    const pdf = await renderer.render(BASE);

    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
    const text = await textOf(pdf);
    expect(text).toContain('RM-2027-000042');
    expect(text).toContain('RECIBO DE PAGO');
    expect(text).toContain('$1,500.00 MXN');
    expect(text).toContain('La Ruta Mochilera');
    expect(text).toContain('352 100 80 79 / 352 144 23 28');
    expect(text).toContain('www.fb.com/larutamochilera');
    expect(text).toContain('RM-7K2Q9X');
    expect(text).toContain('Efectivo');
  });

  it('prints the credited line only when there is one, in the receipt language', async () => {
    const withCredit = await textOf(await renderer.render({ ...BASE, locale: 'es', creditedCents: 30_000 }));
    expect(withCredit).toContain('De este pago, $300.00 MXN quedó como saldo a favor');
    const without = await textOf(await renderer.render({ ...BASE, locale: 'es', creditedCents: 0 }));
    expect(without).not.toContain('saldo a favor');
    const english = await textOf(await renderer.render({ ...BASE, locale: 'en', creditedCents: 30_000 }));
    expect(english).toContain('$300.00 MXN of this payment became account credit');
  });

  it('draws accents and «ñ» with the embedded font', async () => {
    const text = await textOf(await renderer.render(BASE));

    expect(text).toContain('María Peña Núñez');
    expect(text).toContain('Jiménez');
    expect(text).toContain('¡Gracias por viajar con nosotros!');
  });

  it('prints the payment date in the organization timezone', async () => {
    const text = await textOf(await renderer.render(BASE));

    expect(text).toContain('31 de diciembre de 2026');
  });

  it('shows the balance at the time of the payment', async () => {
    const text = await textOf(await renderer.render(BASE));

    expect(text).toContain('$5,000.00 MXN');
    expect(text.match(/\$2,500\.00 MXN/g)).toHaveLength(2);
  });

  it('switches labels, dates and money to English', async () => {
    const text = await textOf(await renderer.render({ ...BASE, locale: 'en', method: 'CREDIT' }));

    expect(text).toContain('PAYMENT RECEIPT');
    expect(text).toContain('Amount received');
    expect(text).toContain('December 31, 2026');
    expect(text).toContain('Account credit');
    expect(text).not.toContain('Fecha de pago');
  });
});
