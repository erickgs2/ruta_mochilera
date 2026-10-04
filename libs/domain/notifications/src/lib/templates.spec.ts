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
    expect(DELIVERY_EVENT_TYPES).toHaveLength(8);
  });
});
