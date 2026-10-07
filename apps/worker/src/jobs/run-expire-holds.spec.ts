import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import { creditBalance } from '@rm/domain-payments';
import { runExpireHolds } from './run-expire-holds';

const db = withTestDb();

beforeAll(async () => {
  await prepareTestDb();
  await withTestQueue();
});

beforeEach(async () => {
  await resetDatabase(db);
  await resetTestQueue();
});

afterAll(async () => {
  await closeTestDb();
  await closeTestQueue();
});

describe('runExpireHolds (the composition the worker and the E2E fixtures use)', () => {
  it('credits what an expired hold had received -- the injection of decision 16 is wired', async () => {
    const staff = await db.user.create({ data: { email: 'staff@agency.test', type: 'STAFF' } });
    const customer = await db.user.create({
      data: {
        email: 'customer@agency.test',
        type: 'CUSTOMER',
        emailVerifiedAt: new Date(),
        customerProfile: { create: { fullName: 'Cliente', phone: '5512345678', birthDate: new Date('1990-01-01'), origin: 'SELF_SIGNUP' } },
      },
    });
    const trip = await db.trip.create({
      data: {
        slug: 'compose-trip',
        status: 'PUBLISHED',
        departureDate: new Date('2027-12-01'),
        returnDate: new Date('2027-12-07'),
        paymentDeadline: new Date('2027-11-01'),
        totalCapacity: 5,
        holdTtlHours: 72,
        minimumDepositCents: 100_000,
        createdById: staff.id,
      },
    });
    const reservation = await db.reservation.create({
      data: {
        code: 'RM-COMPOSE1',
        tripId: trip.id,
        customerId: customer.id,
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
        totalPriceCents: 500_000,
        minimumDepositCents: 100_000,
        paidCents: 40_000,
        paymentDeadline: trip.paymentDeadline,
        source: 'APP',
      },
    });

    await runExpireHolds(db, await withTestQueue());

    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('EXPIRED');
    expect(await creditBalance(db, customer.id)).toBe(40_000);
    expect(await db.customerCreditEntry.count({ where: { kind: 'EXPIRATION', reservationId: reservation.id } })).toBe(1);
  });
});
