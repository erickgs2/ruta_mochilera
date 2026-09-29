import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { Actor } from '@rm/domain-rbac';
import { addBudgetItem, deleteBudgetItem, setPricingPolicy, updateBudgetItem } from './budget-service';

const db = withTestDb();
let actor: Actor;
let tripId: string;

describe('budget service', () => {
  beforeAll(() => prepareTestDb());
  beforeEach(async () => {
    await resetDatabase(db);
    const creator = await db.user.create({ data: { email: 'c@agency.test', type: 'STAFF' } });
    actor = {
      userId: creator.id,
      type: 'STAFF',
      locale: 'es',
      permissions: ['trip.budget.manage'] as Actor['permissions'],
    };
    const trip = await db.trip.create({
      data: {
        slug: 'oaxaca-2026',
        departureDate: new Date('2026-12-01'),
        returnDate: new Date('2026-12-07'),
        paymentDeadline: new Date('2026-11-01'),
        totalCapacity: 20,
        holdTtlHours: 72,
        minimumDepositCents: 100_000,
        marginMode: 'PERCENTAGE',
        marginValue: 2000,
        createdById: creator.id,
      },
    });
    tripId = trip.id;
  });
  afterAll(() => closeTestDb());

  it('recomputes the budget total and the sale price after adding an item', async () => {
    const result = await addBudgetItem(db, actor, tripId, {
      concept: 'Bus',
      supplier: 'Transportes SA',
      quantity: 1,
      unitAmountCents: 500_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.budgetTotalCents).toBe(500_000);
    // 500,000 x 1.20 = 600,000 / 20 seats = 30,000 cents
    expect(result.value.pricePerSeatCents).toBe(30_000);

    const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.budgetTotalCents).toBe(500_000);
    expect(trip.pricePerSeatCents).toBe(30_000);
  });

  it('accumulates several items', async () => {
    await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    const result = await addBudgetItem(db, actor, tripId, { concept: 'Hotel', quantity: 20, unitAmountCents: 120_000 });
    expect(result.ok && result.value.budgetTotalCents).toBe(2_900_000);
  });

  it('recomputes after editing and after deleting an item', async () => {
    const added = await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    if (!added.ok) throw new Error('setup failed');
    const itemId = added.value.items[0].id;

    const edited = await updateBudgetItem(db, actor, itemId, {
      concept: 'Bus',
      quantity: 2,
      unitAmountCents: 500_000,
    });
    expect(edited.ok && edited.value.budgetTotalCents).toBe(1_000_000);

    const removed = await deleteBudgetItem(db, actor, itemId);
    expect(removed.ok && removed.value.budgetTotalCents).toBe(0);
    expect(removed.ok && removed.value.pricePerSeatCents).toBe(0);
  });

  it('keeps a manual price untouched while still reporting the suggestion', async () => {
    await setPricingPolicy(db, actor, tripId, {
      marginMode: 'PERCENTAGE',
      marginValue: 2000,
      priceMode: 'MANUAL',
      manualPricePerSeatCents: 45_000,
    });

    const result = await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pricePerSeatCents).toBe(45_000); // what is actually charged
    expect(result.value.suggestedPricePerSeatCents).toBe(30_000); // what the formula suggests
  });

  it('switching back to AUTO recomputes the price from the budget', async () => {
    await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    await setPricingPolicy(db, actor, tripId, {
      marginMode: 'PERCENTAGE',
      marginValue: 2000,
      priceMode: 'MANUAL',
      manualPricePerSeatCents: 99_900,
    });
    const result = await setPricingPolicy(db, actor, tripId, {
      marginMode: 'PERCENTAGE',
      marginValue: 2000,
      priceMode: 'AUTO',
    });
    expect(result.ok && result.value.pricePerSeatCents).toBe(30_000);
  });

  it('changing the margin mode re-prices the trip', async () => {
    await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    const result = await setPricingPolicy(db, actor, tripId, {
      marginMode: 'FIXED_PER_SEAT',
      marginValue: 10_000,
      priceMode: 'AUTO',
    });
    // 500,000 + (10,000 x 20) = 700,000 / 20 seats = 35,000
    expect(result.ok && result.value.pricePerSeatCents).toBe(35_000);
  });

  it('rejects a non-positive amount', async () => {
    const result = await addBudgetItem(db, actor, tripId, { concept: 'Free', quantity: 1, unitAmountCents: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires a manual price when priceMode is MANUAL', async () => {
    const result = await setPricingPolicy(db, actor, tripId, {
      marginMode: 'PERCENTAGE',
      marginValue: 2000,
      priceMode: 'MANUAL',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('audits every budget mutation', async () => {
    await addBudgetItem(db, actor, tripId, { concept: 'Bus', quantity: 1, unitAmountCents: 500_000 });
    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.action);
    expect(actions).toContain('trip.budget_item_added');
  });
});
