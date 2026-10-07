import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { FakePaymentProvider, type PaymentProvider } from '@rm/payments-stripe';
import { setPaymentProvider } from '../../../../../lib/payment-provider';
import { setQueue } from '../../../../../lib/queue';
import { POST as stripeWebhook } from './route';

const db = withTestDb();

let provider: FakePaymentProvider;
let reservationId: string;
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

/**
 * Posts a webhook exactly the way Stripe does: the raw bytes in the body,
 * the signature over those same bytes in the `Stripe-Signature` header.
 *
 * `body` is a **string**, never an object, on purpose. The signature covers
 * the bytes, so anything that re-serialises the body between Stripe and
 * `verifyWebhook` -- a JSON parse followed by a `JSON.stringify` that
 * reorders keys or drops whitespace -- invalidates it. Passing the string
 * through is what proves the route reads the body raw.
 */
function post(body: string, signature: string | undefined, contentType = 'application/json') {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (signature !== undefined) headers['stripe-signature'] = signature;
  return stripeWebhook(
    new Request('http://localhost/api/v1/webhooks/stripe', { method: 'POST', headers, body })
  );
}

function signed(body: string) {
  return post(body, provider.signWebhookPayload(body));
}

/**
 * A Stripe event body with deliberately awkward formatting: two spaces of
 * indentation and a trailing newline. A round-trip through `JSON.parse` and
 * `JSON.stringify` would not reproduce these bytes, so a signature over
 * them only verifies if the route never re-serialised the body.
 */
function eventBody(overrides: Record<string, unknown> = {}): string {
  const { object = {}, ...event } = overrides as { object?: Record<string, unknown> };
  return (
    JSON.stringify(
      {
        id: `evt_${next()}`,
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'pi_integration',
            amount: 150_000,
            currency: 'mxn',
            payment_method_types: ['card'],
            metadata: { reservationId },
            ...object,
          },
        },
        ...event,
      },
      null,
      2
    ) + '\n'
  );
}

async function seedReservationWithPendingPayment(): Promise<void> {
  const staff = await db.user.create({
    data: { email: 'staff@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Staff' } } },
  });
  const customer = await db.user.create({
    data: {
      email: 'customer@agency.test',
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: { fullName: 'Cliente', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' },
      },
    },
  });
  const trip = await db.trip.create({
    data: {
      slug: 'oaxaca-webhook',
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      preSoldSeats: 0,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staff.id,
      translations: {
        create: [
          { locale: 'es', name: 'Oaxaca', description: 'd', itinerary: 'i', includes: 'a', excludes: 'b' },
          { locale: 'en', name: 'Oaxaca', description: 'd', itinerary: 'i', includes: 'a', excludes: 'b' },
        ],
      },
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: 'RM-WEBHOOK',
      tripId: trip.id,
      customerId: customer.id,
      status: 'HELD',
      holdExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents: 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
  reservationId = reservation.id;
  await db.payment.create({
    data: {
      reservationId: reservation.id,
      amountCents: 150_000,
      method: 'CARD',
      status: 'PENDING',
      provider: 'STRIPE',
      providerIntentId: 'pi_integration',
    },
  });
}

describe('POST /api/v1/webhooks/stripe', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    setQueue(await withTestQueue());
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    sequence = 0;
    provider = new FakePaymentProvider();
    setPaymentProvider(provider);
    await seedReservationWithPendingPayment();
  });

  afterAll(async () => {
    setPaymentProvider(undefined);
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('is public: it needs no access token, only a valid signature', async () => {
    const body = eventBody();

    const response = await signed(body);

    expect(response.status).toBe(200);
    const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_integration' } });
    expect(payment.status).toBe('SUCCEEDED');
  });

  it('verifies the signature over the exact bytes received, not over a re-serialised body', async () => {
    // `eventBody` is pretty-printed with a trailing newline. If anything
    // between the socket and `verifyWebhook` parsed and re-stringified it,
    // the bytes would differ and this signature would not verify.
    const body = eventBody();
    expect(body).toContain('\n  "id"');

    const response = await signed(body);

    expect(response.status).toBe(200);
  });

  it('rejects an invalid signature without touching the database', async () => {
    const body = eventBody();

    const response = await post(body, 'not-a-valid-signature');

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await db.stripeEvent.count()).toBe(0);
    const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_integration' } });
    expect(payment.status).toBe('PENDING');
    const reservation = await db.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.paidCents).toBe(0);
  });

  it('rejects a request with no Stripe-Signature header at all', async () => {
    const response = await post(eventBody(), undefined);

    expect(response.status).toBe(422);
    expect(await db.stripeEvent.count()).toBe(0);
  });

  it('answers 200 to an event type it does not handle', async () => {
    // Stripe retries on every non-2xx. Answering an error to an event we do
    // not care about would make it retry that event forever.
    const body = eventBody({ type: 'customer.subscription.updated' });

    const response = await signed(body);

    expect(response.status).toBe(200);
    const payment = await db.payment.findUniqueOrThrow({ where: { providerIntentId: 'pi_integration' } });
    expect(payment.status).toBe('PENDING');
  });

  it('answers 200 to a redelivery of an event it has already applied', async () => {
    const body = eventBody();

    const first = await signed(body);
    const second = await signed(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const reservation = await db.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.paidCents).toBe(150_000);
  });

  it('answers PAYMENT_PROVIDER_ERROR, never a stack trace, when the provider blows up verifying', async () => {
    const exploding: PaymentProvider = {
      createIntent: provider.createIntent.bind(provider),
      cancelIntent: provider.cancelIntent.bind(provider),
      verifyWebhook: () => {
        throw new Error('stripe client exploded');
      },
    };
    setPaymentProvider(exploding);
    // The route logs the real error server-side on purpose; muted here so a
    // deliberately provoked failure does not look like a broken test run.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await post(eventBody(), 'whatever');

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();

    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(JSON.stringify(body)).not.toContain('stripe client exploded');
  });

  it('accepts the body Stripe actually sends even when the content type is not application/json', async () => {
    // Stripe sends `application/json`, so this is belt and braces rather
    // than a case seen in the wild -- but the signature is the only thing
    // that may ever decide whether this route acts, and a header Stripe
    // happens to set is not a security control.
    const body = eventBody();

    const response = await post(body, provider.signWebhookPayload(body), 'text/plain');

    expect(response.status).toBe(200);
  });
});
