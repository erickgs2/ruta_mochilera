export type ReceiptLocale = 'es' | 'en';

export type ReceiptPaymentMethod = 'CARD' | 'OXXO' | 'SPEI' | 'CASH' | 'LEGACY' | 'CREDIT';

/** What a receipt prints (Phase 2B, business rule 5.4). */
export interface ReceiptData {
  /** The customer's language: labels, dates and money follow it. */
  locale: ReceiptLocale;
  /** The organization's IANA timezone: the payment date is printed in it. */
  timeZone: string;
  organization: {
    name: string;
    address: string;
    phone: string;
    website: string;
  };
  receiptNumber: string;
  paidAt: Date;
  customerName: string;
  tripName: string;
  /** Calendar dates (stored as UTC midnight), printed without a timezone shift. */
  departureDate: Date;
  returnDate: Date;
  reservationCode: string;
  amountCents: number;
  method: ReceiptPaymentMethod;
  /**
   * The reservation's balance **right after this payment**, not today's: a
   * receipt says what was true when the money arrived and never changes.
   */
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /**
   * How much of `amountCents` went to the customer's credit instead of the
   * reservation, because it was above what the reservation still owed
   * (abono libre spec §7.2). 0 when the whole payment fit.
   */
  creditedCents: number;
}

/**
 * Turns receipt data into a PDF. A port, so the worker and the API depend
 * on the shape and not on the PDF library -- and tests can swap in
 * `FakeReceiptRenderer`.
 */
export interface ReceiptRenderer {
  render(data: ReceiptData): Promise<Uint8Array>;
}
