import { describe, expect, it } from 'vitest';
import { DELIVERY_EVENT_TYPES, renderTemplate, type DeliveryEventType } from './templates';

describe('renderTemplate', () => {
  it('renders every event type in Spanish with params interpolated', () => {
    for (const eventType of DELIVERY_EVENT_TYPES) {
      const rendered = renderTemplate(eventType, 'es', {
        tripName: 'Oaxaca',
        holdExpiresAt: '2027-01-01T00:00:00.000Z',
        amount: '$500.00',
        balance: '$0.00',
        reason: 'fondos insuficientes',
        reservationCode: 'RM-0001',
        customerName: 'Erick',
        provider: 'OXXO',
        intentId: 'pi_123',
        expected: '$100.00',
        actual: '$80.00',
      });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(0);
    }
  });

  it('renders every event type in English with params interpolated', () => {
    for (const eventType of DELIVERY_EVENT_TYPES) {
      const rendered = renderTemplate(eventType, 'en', {
        tripName: 'Oaxaca',
        holdExpiresAt: '2027-01-01T00:00:00.000Z',
        amount: '$500.00',
        balance: '$0.00',
        reason: 'insufficient funds',
        reservationCode: 'RM-0001',
        customerName: 'Erick',
        provider: 'OXXO',
        intentId: 'pi_123',
        expected: '$100.00',
        actual: '$80.00',
      });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(0);
    }
  });

  it('interpolates a param into both subject and body', () => {
    const rendered = renderTemplate('PAYMENT_CONFIRMED', 'en', {
      tripName: 'Oaxaca Adventure',
      amount: '$500.00',
      balance: '$0.00',
    });
    expect(rendered.subject).toContain('Oaxaca Adventure');
    expect(rendered.body).toContain('$500.00');
  });

  it('renders Spanish and English differently for the same event type', () => {
    const params = { tripName: 'Oaxaca', amount: '$500.00', balance: '$0.00' };
    const es = renderTemplate('PAYMENT_CONFIRMED', 'es', params);
    const en = renderTemplate('PAYMENT_CONFIRMED', 'en', params);
    expect(es.subject).not.toBe(en.subject);
    expect(es.body).not.toBe(en.body);
  });

  it('leaves an unresolved placeholder visible rather than throwing when a param is missing', () => {
    const rendered = renderTemplate('PAYMENT_CONFIRMED', 'en', { balance: '$0.00' });
    expect(rendered.body).toContain('{{tripName}}');
  });

  it('type-checks DeliveryEventType as the exact union from the brief', () => {
    const sample: DeliveryEventType = 'ORPHAN_PAYMENT';
    expect(DELIVERY_EVENT_TYPES).toContain(sample);
    // Eight from Task 7, plus the two the Stripe webhook needs (Task 10):
    // an expired OXXO voucher and a payment that landed after its hold had
    // already expired; and Task 19's payment that landed after staff had
    // cancelled the reservation; and the customer's notice that staff
    // declined their cancellation request; and Phase 2B's price change and
    // the expired-hold notice that says the money became credit; and the
    // payment whose excess became credit (owner decision D7).
    expect(DELIVERY_EVENT_TYPES).toHaveLength(15);
  });

  it('tells the customer, in both languages, how much of a payment became credit and never quotes a balance', () => {
    const params = { tripName: 'Oaxaca', amount: '$1,500.00 MXN', credited: '$500.00 MXN' };

    const es = renderTemplate('PAYMENT_EXCESS_CREDITED', 'es', params);
    const en = renderTemplate('PAYMENT_EXCESS_CREDITED', 'en', params);

    expect(es.body).toContain('$1,500.00 MXN');
    expect(es.body).toContain('$500.00 MXN');
    expect(es.body).toContain('saldo a favor');
    expect(en.body).toContain('$1,500.00 MXN');
    expect(en.body).toContain('$500.00 MXN');
    expect(en.body).toContain('credit');
    expect(`${es.subject}${es.body}${en.subject}${en.body}`).not.toContain('{{');
  });

  it('says in both languages that the money of an expired hold became credit', () => {
    const params = { tripName: 'Oaxaca', amount: '$400.00 MXN' };

    const es = renderTemplate('HOLD_EXPIRED_CREDIT', 'es', params);
    const en = renderTemplate('HOLD_EXPIRED_CREDIT', 'en', params);

    expect(es.body).toContain('$400.00 MXN');
    expect(es.body).toContain('saldo a favor');
    expect(en.body).toContain('$400.00 MXN');
    expect(en.body).toContain('credit');
    expect(`${es.subject}${es.body}${en.subject}${en.body}`).not.toContain('{{');
  });

  it('puts the staff notice first and mentions credit only when the change created some (Phase 2B)', () => {
    const params = {
      tripName: 'Oaxaca',
      reservationCode: 'RM-1',
      notice: 'Subió el hospedaje.',
      previousTotal: '$5,000.00 MXN',
      newTotal: '$4,000.00 MXN',
      balance: '$0.00 MXN',
    };

    const withoutCredit = renderTemplate('PRICE_CHANGED', 'es', params);
    const withCredit = renderTemplate('PRICE_CHANGED', 'es', { ...params, credit: '$1,000.00 MXN' });
    const english = renderTemplate('PRICE_CHANGED', 'en', { ...params, credit: '$1,000.00 MXN' });

    expect(withoutCredit.body.startsWith('Subió el hospedaje.')).toBe(true);
    expect(withoutCredit.body).toContain('de $5,000.00 MXN a $4,000.00 MXN');
    expect(withoutCredit.body).not.toContain('saldo a favor');
    expect(withCredit.body).toContain('$1,000.00 MXN, quedó como saldo a favor');
    expect(english.body).toContain('is now account credit');
    expect(english.subject).toContain('Oaxaca');
  });

  it('tells the customer their OXXO voucher expired, not that a payment was declined', () => {
    // Business rule 5.3: an unpaid voucher reaching its deadline leaves the
    // payment `EXPIRED`, which is a different thing from a card being
    // refused, and the notice has to say so in the customer's own language.
    const es = renderTemplate('VOUCHER_EXPIRED', 'es', { tripName: 'Oaxaca' });
    const en = renderTemplate('VOUCHER_EXPIRED', 'en', { tripName: 'Oaxaca' });

    expect(es.subject).toContain('Oaxaca');
    expect(es.body.toLowerCase()).toContain('ficha');
    expect(en.body.toLowerCase()).toContain('voucher');
  });

  it('tells a customer whose hold had already expired that the seat was not given back', () => {
    // Business rule 5.3 again, the other half: the money is recorded, the
    // reservation is not revived, and the customer must not be told a
    // balance that implies they are still going.
    const rendered = renderTemplate('PAYMENT_AFTER_EXPIRY', 'es', {
      tripName: 'Oaxaca',
      amount: '$1,000.00 MXN',
    });

    expect(rendered.body).toContain('$1,000.00 MXN');
    expect(rendered.body).not.toContain('{{');
  });

  it('tells a customer who paid after staff cancelled that the payment is recorded, in both locales', () => {
    for (const locale of ['es', 'en'] as const) {
      const rendered = renderTemplate('PAYMENT_AFTER_CANCELLATION', locale, {
        tripName: 'Oaxaca',
        amount: '$1,000.00 MXN',
      });

      expect(rendered.body).toContain('$1,000.00 MXN');
      expect(rendered.body).toContain('Oaxaca');
      expect(`${rendered.subject} ${rendered.body}`).not.toContain('{{');
    }
  });
});
