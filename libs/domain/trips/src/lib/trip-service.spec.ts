import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
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
