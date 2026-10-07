import type { ReceiptData, ReceiptRenderer } from './receipt-renderer';

/**
 * A stand-in for tests: a tiny "PDF" whose body is the data it was given, so
 * a suite can assert *what* was rendered without parsing a real PDF.
 */
export class FakeReceiptRenderer implements ReceiptRenderer {
  readonly rendered: ReceiptData[] = [];

  async render(data: ReceiptData): Promise<Uint8Array> {
    this.rendered.push(data);
    return new TextEncoder().encode(`%PDF-fake\n${JSON.stringify(data)}`);
  }

  /** Reads back the data a fake PDF carries. */
  static parse(pdf: Uint8Array): ReceiptData {
    const text = new TextDecoder().decode(pdf);
    return JSON.parse(text.slice(text.indexOf('\n') + 1)) as ReceiptData;
  }
}
