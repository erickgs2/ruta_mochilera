import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { DbTransactionClient, ReservationStatus } from '@rm/db';
import { adjustCredit, creditBalance, creditFromExpiration } from '@rm/domain-payments';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { loginAs, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../lib/queue';
import { POST as applyCreditRoute } from './[reservationId]/apply-credit/route';
import { POST as cashRoute } from './[reservationId]/payments/route';

/**
 * The two counter routes revive a reservation whose hold ran out (decision
 * 13). The wiring is in the routes -- they inject `reviveReservationSeat` --
 * so these go through the real handlers: without the injection both would
 * answer `HOLD_EXPIRED` / `INVALID_STATUS_TRANSITION` again and the domain
 * suites, which pass the hook themselves, would stay green.
 */

const db = withTestDb();
const HOUR_MS = 60 * 60 * 1000;

function post(token: string, reservationId: string, path: 'payments' | 'apply-credit', body: unknown) {
  return [
    new Request(`http://localhost/api/v1/admin/reservations/${reservationId}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ reservationId }) },
  ] as const;
}

let sequence = 0;
let staffId: string;

async function seedTrip(totalCapacity = 5) {
  sequence += 1;
  return db.trip.create({
    data: {
      slug: `revival-route-${sequence}`,
      status: 'PUBLISHED',
      departureDate: new Date('2027-12-01'),
      returnDate: new Date('2027-12-07'),
      paymentDeadline: new Date('2027-11-01'),
      totalCapacity,
      holdTtlHours: 72,
      minimumDepositCents: 100_000,
      pricePerSeatCents: 500_000,
      createdById: staffId,
    },
  });
}

async function seedReservation(tripId: string, status: ReservationStatus, paidCents = 0, holdExpiresAt?: Date) {
  sequence += 1;
  const customer = await db.user.create({
    data: {
      email: `revival-route-${sequence}@example.com`,
      type: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      customerProfile: { create: { fullName: 'Cliente', phone: '3521008079', birthDate: new Date('1990-05-17'), origin: 'BRANCH' } },
    },
  });
  const reservation = await db.reservation.create({
    data: {
      code: `RM-RT${sequence}`,
      tripId,
      customerId: customer.id,
      status,
      holdExpiresAt: status === 'HELD' ? (holdExpiresAt ?? new Date(Date.now() + HOUR_MS)) : null,
      totalPriceCents: 500_000,
      minimumDepositCents: 100_000,
      paidCents,
      paymentDeadline: new Date('2027-11-01'),
      source: 'BRANCH',
    },
  });
  if (paidCents > 0) {
    await db.payment.create({
      data: { reservationId: reservation.id, amountCents: paidCents, method: 'CASH', status: 'SUCCEEDED', provider: 'MANUAL', paidAt: new Date() },
    });
  }
  return reservation;
}

/** An `EXPIRED` reservation that had received `paidCents`, already credited the way `expireHolds` does. */
async function seedExpired(tripId: string, paidCents = 40_000) {
  const reservation = await seedReservation(tripId, 'EXPIRED', paidCents);
  await db.$transaction((tx: DbTransactionClient) =>
    creditFromExpiration(tx, { customerId: reservation.customerId, reservationId: reservation.id, paidCents })
  );
  return reservation;
}

describe('counter routes reviving a reservation whose hold ran out', () => {
  let queue: PgBoss;
  let token: string;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    queue = await withTestQueue();
    setQueue(queue);
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
    token = await loginAs(db, 'cashier@agency.test', ['payment.register', 'payment.credit.apply']);
    staffId = (await db.user.findFirstOrThrow({ where: { email: 'cashier@agency.test' } })).id;
  });
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('takes cash for an EXPIRED reservation: it revives, takes its credit back and becomes ACTIVE', async () => {
    const reservation = await seedExpired((await seedTrip()).id);

    const response = await cashRoute(...post(token, reservation.id, 'payments', { amountCents: 60_000 }));

    expect(response.status).toBe(201);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: 'ACTIVE', paidCents: 100_000 });
    expect(await creditBalance(db, reservation.customerId)).toBe(0);
    expect(await db.customerCreditEntry.count({ where: { kind: 'REVIVAL', reservationId: reservation.id } })).toBe(1);
  });

  it('takes cash for a HELD reservation whose time already ran out', async () => {
    const reservation = await seedReservation((await seedTrip()).id, 'HELD', 0, new Date(Date.now() - HOUR_MS));

    const response = await cashRoute(...post(token, reservation.id, 'payments', { amountCents: 100_000 }));

    expect(response.status).toBe(201);
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('ACTIVE');
  });

  it('answers TRIP_SOLD_OUT and writes nothing when the seat is gone', async () => {
    const trip = await seedTrip(1);
    const reservation = await seedExpired(trip.id);
    await seedReservation(trip.id, 'ACTIVE');

    const response = await cashRoute(...post(token, reservation.id, 'payments', { amountCents: 60_000 }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('TRIP_SOLD_OUT');
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, reservation.customerId)).toBe(40_000);
  });

  it('applies credit to an EXPIRED reservation: its own credit comes back first, the rest of the balance pays', async () => {
    const reservation = await seedExpired((await seedTrip()).id);
    const given = await adjustCredit(db, { customerId: reservation.customerId, amountCents: 100_000, reason: 'Courtesy', actorId: staffId });
    expect(given.ok).toBe(true);

    const response = await applyCreditRoute(...post(token, reservation.id, 'apply-credit', { amountCents: 60_000 }));

    expect(response.status).toBe(201);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: 'ACTIVE', paidCents: 100_000 });
    // 40,000 expiry + 100,000 courtesy − 40,000 taken back − 60,000 applied.
    expect(await creditBalance(db, reservation.customerId)).toBe(40_000);
  });

  it('answers CREDIT_INSUFFICIENT and leaves the reservation EXPIRED when the credit left cannot pay', async () => {
    const reservation = await seedExpired((await seedTrip()).id);

    const response = await applyCreditRoute(...post(token, reservation.id, 'apply-credit', { amountCents: 20_000 }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CREDIT_INSUFFICIENT');
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, reservation.customerId)).toBe(40_000);
  });

  it('never revives a CANCELLED reservation', async () => {
    const reservation = await seedReservation((await seedTrip()).id, 'CANCELLED');

    const response = await cashRoute(...post(token, reservation.id, 'payments', { amountCents: 1_000 }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('INVALID_STATUS_TRANSITION');
  });
});
