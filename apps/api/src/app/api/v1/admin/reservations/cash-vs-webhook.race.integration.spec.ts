import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { FakePaymentProvider } from '@rm/payments-stripe';
import { loginAs, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setPaymentProvider } from '../../../../../lib/payment-provider';
import { setQueue } from '../../../../../lib/queue';
import { POST as stripeWebhook } from '../../webhooks/stripe/route';
import { POST as applyCreditRoute } from './[reservationId]/apply-credit/route';
import { POST as cashRoute } from './[reservationId]/payments/route';

/**
 * The crossing that deadlocked (40P01, surfacing as Prisma P2034): counter
 * cash and the Stripe webhook landing on the same live `HELD` reservation at
 * the same moment, through the real routes -- the cash route injects
 * `reviveReservationSeat`, which locks the trip before the reservation, and
 * that injection only exists in the route.
 *
 * Every money path must take its locks in the order written at the top of
 * `@rm/domain-payments`' `payment-service.ts`: trip, reservation, customer,
 * receipt counter. The webhook used to lock the reservation first and then
 * update it twice; PostgreSQL re-checks the foreign keys of a row the same
 * transaction already updated, so the second update took `FOR KEY SHARE` on
 * the trip *after* the reservation -- while the cash request held the trip
 * and waited for the reservation.
 *
 * A race, so it runs many rounds: one round alone rarely lines the two
 * transactions up.
 */

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;
// 40 rounds by default (seconds); `RACE_ROUNDS=200` for a longer soak.
const ROUNDS = Number(process.env['RACE_ROUNDS'] ?? 40) || 40;
const DEPOSIT = 100_000;

let provider: FakePaymentProvider;
let staffId: string;
let token: string;
let sequence = 0;

async function seedRound() {
  sequence += 1;
  const trip = await db.trip.create({
    data: {
      slug: `race-${sequence}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity: 20,
      holdTtlHours: 72,
      minimumDepositCents: DEPOSIT,
      pricePerSeatCents: 500_000,
      createdById: staffId,
      translations: {
        create: [{ locale: 'es', name: 'Carrera', description: 'd', itinerary: 'i', includes: 'a', excludes: 'b' }],
      },
    },
  });
  const customer = await db.user.create({
    data: {
      email: `race-${sequence}@example.com`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: { create: { fullName: 'Cliente', phone: '3521008079', birthDate: new Date('1990-05-17'), origin: 'SELF_SIGNUP' } },
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: `RM-RACE${sequence}`,
      tripId: trip.id,
      customerId: customer.id,
      status: 'HELD',
      holdExpiresAt: new Date(Date.now() + 72 * HOUR_MS),
      totalPriceCents: 500_000,
      minimumDepositCents: DEPOSIT,
      paidCents: 0,
      paymentDeadline: trip.paymentDeadline,
      source: 'APP',
    },
  });
  const intentId = `pi_race_${sequence}`;
  await db.payment.create({
    data: {
      reservationId: reservation.id,
      amountCents: DEPOSIT,
      method: 'OXXO',
      status: 'PENDING',
      provider: 'STRIPE',
      providerIntentId: intentId,
      voucherExpiresAt: reservation.holdExpiresAt,
    },
  });
  return { reservation, intentId };
}

function counter(path: 'payments' | 'apply-credit', reservationId: string) {
  const route = path === 'payments' ? cashRoute : applyCreditRoute;
  return route(
    new Request(`http://localhost/api/v1/admin/reservations/${reservationId}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ amountCents: DEPOSIT }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ reservationId }) }
  );
}

function voucherPaid(reservationId: string, intentId: string) {
  const body = JSON.stringify({
    id: `evt_${intentId}`,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: intentId,
        amount: DEPOSIT,
        currency: 'mxn',
        payment_method_types: ['oxxo'],
        metadata: { reservationId },
      },
    },
  });
  return stripeWebhook(
    new Request('http://localhost/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': provider.signWebhookPayload(body) },
      body,
    })
  );
}

describe('counter money racing the Stripe webhook on the same reservation', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    setQueue(await withTestQueue());
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
    provider = new FakePaymentProvider();
    setPaymentProvider(provider);
    token = await loginAs(db, 'cashier@agency.test', ['payment.register', 'payment.credit.apply']);
    staffId = (await db.user.findFirstOrThrow({ where: { email: 'cashier@agency.test' } })).id;
  });

  afterAll(async () => {
    setPaymentProvider(undefined);
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it.each([
    ['cash', 'payments'],
    ['applied credit', 'apply-credit'],
  ] as const)('%s never deadlocks against the webhook, and leaves the money where it belongs', async (_label, path) => {
    const failures: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const { reservation, intentId } = await seedRound();
      if (path === 'apply-credit') {
        await db.customerCreditEntry.create({
          data: { customerId: reservation.customerId, amountCents: DEPOSIT, kind: 'ADJUSTMENT', reason: 'Cortesía' },
        });
      }

      const [counterResponse, webhookResponse] = await Promise.all([
        counter(path, reservation.id),
        voucherPaid(reservation.id, intentId),
      ]);

      if (counterResponse.status >= 300) {
        failures.push(`round ${round}: ${path} ${counterResponse.status} ${await counterResponse.text()}`);
      }
      if (webhookResponse.status >= 300) {
        failures.push(`round ${round}: webhook ${webhookResponse.status} ${await webhookResponse.text()}`);
      }

      // Both payments fit the 500,000 total, so all of it lands on the reservation.
      const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      const succeeded = await db.payment.aggregate({
        where: { reservationId: reservation.id, status: 'SUCCEEDED' },
        _sum: { amountCents: true },
      });
      const overpaid = await db.customerCreditEntry.aggregate({
        where: { reservationId: reservation.id, kind: 'OVERPAYMENT' },
        _sum: { amountCents: true },
      });
      expect(after.paidCents).toBeLessThanOrEqual(after.totalPriceCents);
      expect(after.paidCents).toBe((succeeded._sum.amountCents ?? 0) - (overpaid._sum.amountCents ?? 0));
    }

    expect(failures).toEqual([]);
  }, 180_000);
});
