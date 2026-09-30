import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { addBudgetItem } from '@rm/domain-costing';
import type { Actor } from '@rm/domain-rbac';
import { changeTripStatus, createTrip, listTrips, updateTrip } from './trip-service';

const db = withTestDb();

const actorWith = (permissions: string[]): Actor => ({
  userId: creatorId,
  type: 'STAFF',
  locale: 'es',
  permissions: permissions as Actor['permissions'],
});

let creatorId: string;

const baseInput = {
  departureDate: new Date('2026-12-01'),
  returnDate: new Date('2026-12-07'),
  paymentDeadline: new Date('2026-11-01'),
  totalCapacity: 20,
  preSoldSeats: 0,
  holdTtlHours: 72,
  minimumDepositCents: 100_000,
  marginMode: 'PERCENTAGE' as const,
  marginValue: 2000,
  translations: [
    { locale: 'es' as const, name: 'Oaxaca Mágica', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
  ],
  isBackfilled: false,
};

describe('trip service', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(async () => {
    await resetDatabase(db);
    const creator = await db.user.create({
      data: { email: 'creator@agency.test', type: 'STAFF', staffProfile: { create: { fullName: 'Creator' } } },
    });
    creatorId = creator.id;
  });
  afterAll(() => closeTestDb());

  it('creates a DRAFT trip with a generated slug and its Spanish translation', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('DRAFT');
    expect(result.value.slug).toBe('oaxaca-magica-2026');
    expect(result.value.translations).toHaveLength(1);
    expect(result.value.availableSeats).toBe(20);
  });

  it('requires a Spanish translation', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput,
      translations: [
        { locale: 'en', name: 'Magic Oaxaca', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_REQUIRED_TRANSLATION');
  });

  it('accepts an optional English translation alongside Spanish', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput,
      translations: [
        ...baseInput.translations,
        { locale: 'en', name: 'Magic Oaxaca', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
      ],
    });
    expect(result.ok && result.value.translations).toHaveLength(2);
  });

  it('rejects a capacity of zero', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), { ...baseInput, totalCapacity: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_CAPACITY');
  });

  it('rejects pre-sold seats above the total capacity', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput, totalCapacity: 10, preSoldSeats: 11, isBackfilled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_CAPACITY');
  });

  it('rejects a return date before departure', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput, returnDate: new Date('2026-11-25'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a payment deadline after departure', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput, paymentDeadline: new Date('2026-12-05'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects past departure dates without the backfill permission', async () => {
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput,
      departureDate: new Date('2020-01-10'),
      returnDate: new Date('2020-01-17'),
      paymentDeadline: new Date('2019-12-01'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('rejects an ordinary future trip explicitly flagged as backfilled without the permission', async () => {
    // `isBackfilled: true` must demand `data.backfill` on its own, even when
    // none of the data-derived triggers (past date, pre-sold seats, non-DRAFT
    // initial status) fire -- otherwise a caller could pollute the audit
    // trail by labelling a perfectly ordinary trip as a hot-start backfill.
    const result = await createTrip(db, actorWith(['trip.create']), {
      ...baseInput,
      isBackfilled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('allows a past, in-progress trip with pre-sold seats when backfilling', async () => {
    const result = await createTrip(db, actorWith(['trip.create', 'data.backfill']), {
      ...baseInput,
      departureDate: new Date('2020-01-10'),
      returnDate: new Date('2020-01-17'),
      paymentDeadline: new Date('2019-12-01'),
      preSoldSeats: 8,
      isBackfilled: true,
      initialStatus: 'IN_PROGRESS',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('IN_PROGRESS');
    expect(result.value.isBackfilled).toBe(true);
    expect(result.value.availableSeats).toBe(12);
  });

  it('appends a counter when the slug already exists', async () => {
    await createTrip(db, actorWith(['trip.create']), baseInput);
    const second = await createTrip(db, actorWith(['trip.create']), baseInput);
    expect(second.ok && second.value.slug).toBe('oaxaca-magica-2026-2');
  });

  it('recovers with the next slug when two concurrent creates collide on the same one', async () => {
    // Reproduces the race `uniqueSlug`'s pre-check alone cannot close: a
    // second trip with the same slug is inserted immediately after the first
    // `findUnique` check has already reported the base slug free, so
    // `createTrip`'s own insert collides on the database's unique index
    // rather than on the application-level pre-check. See the cast note in
    // `role-service.spec.ts`: `mockImplementation` requires an exact
    // structural match with Prisma's fluent client type, which a plain async
    // replacement never has.
    const originalFindUnique = db.trip.findUnique.bind(db.trip);
    let racerInserted = false;
    const findUniqueSpy = vi.spyOn(db.trip, 'findUnique').mockImplementation(
      (async (args: Parameters<typeof db.trip.findUnique>[0]) => {
        const result = await originalFindUnique(args);
        if (!racerInserted && args?.where?.slug === 'oaxaca-magica-2026') {
          racerInserted = true;
          await db.trip.create({
            data: {
              slug: 'oaxaca-magica-2026',
              departureDate: baseInput.departureDate,
              returnDate: baseInput.returnDate,
              paymentDeadline: baseInput.paymentDeadline,
              totalCapacity: baseInput.totalCapacity,
              holdTtlHours: baseInput.holdTtlHours,
              minimumDepositCents: baseInput.minimumDepositCents,
              marginMode: baseInput.marginMode,
              marginValue: baseInput.marginValue,
              createdById: creatorId,
            },
          });
        }
        return result;
      }) as unknown as typeof db.trip.findUnique
    );

    try {
      const result = await createTrip(db, actorWith(['trip.create']), baseInput);
      expect(result.ok).toBe(true);
      // The racer took the base slug, so the retry inside `createTrip` must
      // land on the next free one -- proving the backstop recomputed and
      // retried rather than the first-pass loop having somehow avoided the
      // race.
      if (result.ok) expect(result.value.slug).toBe('oaxaca-magica-2026-2');
    } finally {
      findUniqueSpy.mockRestore();
    }
  });

  it('refuses to publish a trip without images or a price', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await changeTripStatus(db, actorWith(['trip.publish']), created.value.id, 'PUBLISHED');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TRIP_NOT_PUBLISHABLE');
      expect(result.error.details).toEqual({ missing: ['images', 'price'] });
    }
  });

  it('publishes a trip that has an image and a price', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');
    await db.tripImage.create({
      data: { tripId: created.value.id, storageKey: 'trips/x/1.jpg', position: 0, isCover: true },
    });
    await db.trip.update({ where: { id: created.value.id }, data: { pricePerSeatCents: 1_500_000 } });

    const result = await changeTripStatus(db, actorWith(['trip.publish']), created.value.id, 'PUBLISHED');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.publishedAt).not.toBeNull();
  });

  it('rejects an illegal status transition', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await changeTripStatus(db, actorWith(['trip.publish']), created.value.id, 'COMPLETED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('refuses to cancel a trip for an actor holding trip.publish but not trip.cancel', async () => {
    // This is the exact over-permissive gap the permission split closes: a
    // publisher must no longer be able to cancel just by virtue of holding
    // trip.publish -- see docs/business-rules/trips.md.
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await changeTripStatus(db, actorWith(['trip.publish']), created.value.id, 'CANCELLED');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.details).toEqual({ permission: 'trip.cancel' });
    }
  });

  it('cancels a trip for an actor holding trip.cancel', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await changeTripStatus(db, actorWith(['trip.cancel']), created.value.id, 'CANCELLED');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('CANCELLED');
  });

  it('refuses a non-cancel transition for an actor holding only trip.cancel', async () => {
    // The split cuts both ways: trip.cancel is not a substitute for
    // trip.publish on any transition other than CANCELLED.
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await changeTripStatus(db, actorWith(['trip.cancel']), created.value.id, 'PUBLISHED');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.details).toEqual({ permission: 'trip.publish' });
    }
  });

  it('replaces translations on update and keeps the slug stable', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const updated = await updateTrip(db, actorWith(['trip.update']), created.value.id, {
      ...baseInput,
      translations: [
        { locale: 'es', name: 'Oaxaca Renombrada', description: 'd2', itinerary: 'i', includes: 'inc', excludes: 'exc' },
      ],
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // The slug does not change: it may already be shared on social media.
    expect(updated.value.slug).toBe('oaxaca-magica-2026');
    expect(updated.value.translations[0].name).toBe('Oaxaca Renombrada');
  });

  it('rejects a capacity update that would drop below the pre-sold seats being persisted', async () => {
    // With the Phase 2 `committedSeats` stub returning zero, the only way to
    // exercise CAPACITY_BELOW_COMMITTED today is through pre-sold seats: the
    // update tries to set 15 pre-sold seats against a capacity of only 10.
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const result = await updateTrip(db, actorWith(['trip.update']), created.value.id, {
      ...baseInput,
      totalCapacity: 10,
      preSoldSeats: 15,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CAPACITY_BELOW_COMMITTED');
      expect(result.error.details).toEqual({ alreadyTaken: 15 });
    }

    // The failed update must not have written anything.
    const untouched = await db.trip.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(untouched.totalCapacity).toBe(20);
    expect(untouched.preSoldSeats).toBe(0);
  });

  it('filters the list by status and by name', async () => {
    await createTrip(db, actorWith(['trip.create']), baseInput);
    await createTrip(db, actorWith(['trip.create']), {
      ...baseInput,
      translations: [
        { locale: 'es', name: 'Chiapas Total', description: 'd', itinerary: 'i', includes: 'inc', excludes: 'exc' },
      ],
    });

    const drafts = await listTrips(db, { status: 'DRAFT' });
    expect(drafts.ok && drafts.value).toHaveLength(2);

    const search = await listTrips(db, { search: 'chiapas' });
    expect(search.ok && search.value).toHaveLength(1);
  });

  it('reprices the trip when totalCapacity changes through updateTrip', async () => {
    // Regression test for a cross-domain gap found in Task 13: capacity is a
    // divisor in the per-seat price formula, but `updateTrip` lives here and
    // pricing lives in `libs/domain/costing`, so nothing used to connect the
    // two. This must fail before `updateTrip` calls into costing to reprice.
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');

    const priced = await addBudgetItem(db, actorWith(['trip.budget.manage']), created.value.id, {
      concept: 'Bus',
      quantity: 1,
      unitAmountCents: 500_000,
    });
    if (!priced.ok) throw new Error('setup failed');
    // 500,000 x 1.20 margin / 20 seats = 30,000 cents per seat.
    expect(priced.value.pricePerSeatCents).toBe(30_000);

    const updated = await updateTrip(db, actorWith(['trip.update']), created.value.id, {
      ...baseInput,
      totalCapacity: 30,
    });

    expect(updated.ok).toBe(true);
    // Same 600,000 total-with-margin now split across 30 seats: 20,000 cents.
    if (updated.ok) expect(updated.value.pricePerSeatCents).toBe(20_000);

    const stored = await db.trip.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(stored.pricePerSeatCents).toBe(20_000);
  });

  it('writes an audit entry on creation and on status change', async () => {
    const created = await createTrip(db, actorWith(['trip.create']), baseInput);
    if (!created.ok) throw new Error('setup failed');
    await db.tripImage.create({
      data: { tripId: created.value.id, storageKey: 'trips/x/1.jpg', position: 0, isCover: true },
    });
    await db.trip.update({ where: { id: created.value.id }, data: { pricePerSeatCents: 1_500_000 } });
    await changeTripStatus(db, actorWith(['trip.publish']), created.value.id, 'PUBLISHED');

    const actions = (await db.auditLog.findMany({ where: { entityType: 'Trip' }, orderBy: { createdAt: 'asc' } }))
      .map((entry) => entry.action);
    expect(actions).toEqual(['trip.created', 'trip.status_changed']);
  });
});
