import type { Db, DbTransactionClient } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import type { Actor } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';
import { calculatePricing, type MarginMode } from './pricing';

export interface BudgetItemDto {
  id: string;
  concept: string;
  supplier: string | null;
  quantity: number;
  unitAmountCents: number;
  totalCents: number;
  notes: string | null;
}

export interface TripCostingDto {
  tripId: string;
  items: BudgetItemDto[];
  budgetTotalCents: number;
  marginMode: MarginMode;
  marginValue: number;
  priceMode: 'AUTO' | 'MANUAL';
  /** What `calculatePricing` produces from the current budget and margin, always
   *  reported -- even in MANUAL mode, where it is never discarded, only overridden. */
  suggestedPricePerSeatCents: number;
  /** What the trip actually sells for: the suggestion in AUTO, the administrator's
   *  own figure in MANUAL. */
  pricePerSeatCents: number;
  totalCapacity: number;
}

export interface BudgetItemInput {
  concept: string;
  supplier?: string;
  quantity: number;
  unitAmountCents: number;
  notes?: string;
}

export interface PricingPolicyInput {
  marginMode: MarginMode;
  marginValue: number;
  priceMode: 'AUTO' | 'MANUAL';
  manualPricePerSeatCents?: number;
}

/** The shape `computeCosting` needs from a trip row -- deliberately narrower
 *  than the full Prisma model, so it stays a plain data-in/data-out function. */
interface TripForCosting {
  id: string;
  totalCapacity: number;
  marginMode: MarginMode;
  marginValue: number;
  priceMode: 'AUTO' | 'MANUAL';
  pricePerSeatCents: number;
  budgetItems: {
    id: string;
    concept: string;
    supplier: string | null;
    quantity: number;
    unitAmountCents: number;
    notes: string | null;
  }[];
}

/**
 * Computes the trip's full costing picture from its current budget items and
 * margin/price policy. Pure: reads only what is passed in, writes nothing to
 * any database. This is what `listBudgetItems` calls directly -- a read never
 * has a side effect -- and what `persistCosting` wraps for the mutations that
 * need the result stored.
 *
 * `manualPriceOverride` exists solely for `setPricingPolicy`: the moment an
 * administrator types a new manual price, that number has to flow into the
 * result somehow, and this parameter is how it gets there before it has been
 * written to the trip row at all. When omitted, MANUAL falls back to whatever
 * price is already on `trip.pricePerSeatCents` -- the normal case where a
 * budget item changed but the price policy itself did not.
 */
function computeCosting(trip: TripForCosting, manualPriceOverride?: number): Result<TripCostingDto> {
  const pricing = calculatePricing({
    lines: trip.budgetItems.map((item) => ({
      quantity: item.quantity,
      unitAmountCents: item.unitAmountCents,
    })),
    marginMode: trip.marginMode,
    marginValue: trip.marginValue,
    totalCapacity: trip.totalCapacity,
  });
  if (!pricing.ok) return pricing;

  // MANUAL takes the freshly-typed override when there is one, otherwise keeps
  // whatever price is already stored; AUTO always takes the computed suggestion.
  const pricePerSeatCents =
    trip.priceMode === 'MANUAL' ? manualPriceOverride ?? trip.pricePerSeatCents : pricing.value.pricePerSeatCents;

  return ok({
    tripId: trip.id,
    items: trip.budgetItems.map((item) => ({
      id: item.id,
      concept: item.concept,
      supplier: item.supplier,
      quantity: item.quantity,
      unitAmountCents: item.unitAmountCents,
      totalCents: item.quantity * item.unitAmountCents,
      notes: item.notes,
    })),
    budgetTotalCents: pricing.value.budgetTotalCents,
    marginMode: trip.marginMode,
    marginValue: trip.marginValue,
    priceMode: trip.priceMode,
    suggestedPricePerSeatCents: pricing.value.pricePerSeatCents,
    pricePerSeatCents,
    totalCapacity: trip.totalCapacity,
  });
}

/**
 * Single source of truth for the trip's money columns (`budget_total_cents`
 * and `price_per_seat_cents`): the only function in this file that writes
 * them, via `computeCosting` above. Every mutation that can change the sale
 * price -- adding, editing or deleting a budget item, or changing the
 * margin/price policy -- calls this, and nothing else writes those two
 * columns. That is what keeps them from ever drifting out of sync with the
 * budget items that produced them.
 *
 * Takes `tx`, not `db`: every caller is a mutation that already opened
 * `db.$transaction(...)` for its own item or policy write, and this must run
 * inside that same transaction. Two reasons. First, atomicity: without it,
 * the item write and the price recompute would be two separate commits, and
 * a crash between them would leave a budget item on the trip whose stored
 * price does not yet reflect it. Second, and why this function exists at
 * all: a plain read must never write to the database, so the recompute has
 * to live only on the mutation side, inside the mutation's own transaction --
 * not as a step `listBudgetItems` (or anything else on a read path) can reach.
 *
 * No separate audit entry is recorded here. The recompute is a deterministic
 * consequence of whatever the calling mutation already audited (the budget
 * item or policy change), not an independent event of its own.
 *
 * Editing the budget of an already-published trip re-prices the trip itself
 * through this same function, but Phase 1 has no `Reservation` model yet, so
 * there is nothing here that could touch one. Once reservations exist
 * (Phase 2), they freeze their own total at booking time and this function
 * must keep not touching them -- propagating a new price to existing
 * reservations is a deliberate, separate operation, not a side effect of
 * editing a budget line.
 */
async function persistCosting(
  tx: DbTransactionClient,
  tripId: string,
  manualPriceOverride?: number
): Promise<Result<TripCostingDto>> {
  const trip = await tx.trip.findUnique({ where: { id: tripId }, include: { budgetItems: true } });
  if (!trip) return fail('NOT_FOUND');

  const costing = computeCosting(trip, manualPriceOverride);
  if (!costing.ok) return costing;

  await tx.trip.update({
    where: { id: tripId },
    data: {
      budgetTotalCents: costing.value.budgetTotalCents,
      pricePerSeatCents: costing.value.pricePerSeatCents,
    },
  });

  return costing;
}

/**
 * Re-prices a trip from its current budget and margin/price policy, inside a
 * transaction the caller already has open. `total_capacity` is one of
 * `calculatePricing`'s own inputs, but it lives on `Trip`, owned by
 * `libs/domain/trips`, not here -- so this package can never notice a
 * capacity change on its own. `libs/domain/trips`'s `updateTrip` calls this,
 * inside its own transaction, whenever `totalCapacity` changes. See
 * `docs/business-rules/trips.md` for the business rule this closes.
 *
 * A thin wrapper over `persistCosting`, which stays unexported: every
 * in-package mutation already reaches it, and a cross-domain caller needs a
 * name that does not read as "pass a manual price override" the way
 * `persistCosting`'s second parameter does.
 */
export async function repriceTrip(tx: DbTransactionClient, tripId: string): Promise<Result<TripCostingDto>> {
  return persistCosting(tx, tripId);
}

/**
 * Returns the trip's full costing picture -- not just the line items, since
 * the costing screen always needs the total, the margin and the price
 * alongside the list. A pure read: it calls `computeCosting` directly and
 * never touches `persistCosting`, so viewing the costing screen can never
 * write to the trip row (Task 14 wraps this in a `GET` endpoint, where a
 * write would be a genuine surprise).
 *
 * One consequence of a read no longer refreshing the stored columns: if the
 * budget items and policy are unchanged but the *inputs* to the formula
 * change some other way, the stored `price_per_seat_cents` can go stale
 * until the next budget mutation. `total_capacity` is exactly such an input,
 * and it lives on `Trip`, owned by `libs/domain/trips`'s `updateTrip`. That
 * gap is closed as of Task 14: `updateTrip` calls `repriceTrip` (below),
 * inside its own transaction, whenever `totalCapacity` changes, so the
 * stored price never outlives the capacity it was computed against.
 * `listBudgetItems` still recomputes from the current row on every read
 * regardless, so it reports the correct number even in the window before a
 * capacity change is persisted.
 */
export async function listBudgetItems(db: Db, tripId: string): Promise<Result<TripCostingDto>> {
  const trip = await db.trip.findUnique({ where: { id: tripId }, include: { budgetItems: true } });
  if (!trip) return fail('NOT_FOUND');
  return computeCosting(trip);
}

/** A free line item is not a line item: both fields must be strictly positive. */
function validateItem(input: BudgetItemInput): Result<null> {
  if (input.quantity <= 0) return fail('VALIDATION_FAILED', { field: 'quantity' });
  if (input.unitAmountCents <= 0) return fail('VALIDATION_FAILED', { field: 'unitAmountCents' });
  return ok(null);
}

export async function addBudgetItem(
  db: Db,
  actor: Actor,
  tripId: string,
  input: BudgetItemInput
): Promise<Result<TripCostingDto>> {
  const valid = validateItem(input);
  if (!valid.ok) return valid;

  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true } });
  if (!trip) return fail('NOT_FOUND');

  return db.$transaction(async (tx) => {
    const created = await tx.tripBudgetItem.create({
      data: { ...input, tripId, createdById: actor.userId },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.budget_item_added',
      entityType: 'TripBudgetItem',
      entityId: created.id,
      after: { tripId, ...input },
    });
    return persistCosting(tx, tripId);
  });
}

export async function updateBudgetItem(
  db: Db,
  actor: Actor,
  itemId: string,
  input: BudgetItemInput
): Promise<Result<TripCostingDto>> {
  const valid = validateItem(input);
  if (!valid.ok) return valid;

  const existing = await db.tripBudgetItem.findUnique({ where: { id: itemId } });
  if (!existing) return fail('NOT_FOUND');

  return db.$transaction(async (tx) => {
    await tx.tripBudgetItem.update({ where: { id: itemId }, data: input });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.budget_item_updated',
      entityType: 'TripBudgetItem',
      entityId: itemId,
      before: {
        concept: existing.concept,
        quantity: existing.quantity,
        unitAmountCents: existing.unitAmountCents,
      },
      after: input,
    });
    return persistCosting(tx, existing.tripId);
  });
}

export async function deleteBudgetItem(
  db: Db,
  actor: Actor,
  itemId: string
): Promise<Result<TripCostingDto>> {
  const existing = await db.tripBudgetItem.findUnique({ where: { id: itemId } });
  if (!existing) return fail('NOT_FOUND');

  return db.$transaction(async (tx) => {
    await tx.tripBudgetItem.delete({ where: { id: itemId } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.budget_item_deleted',
      entityType: 'TripBudgetItem',
      entityId: itemId,
      before: { concept: existing.concept, unitAmountCents: existing.unitAmountCents },
    });
    return persistCosting(tx, existing.tripId);
  });
}

export async function setPricingPolicy(
  db: Db,
  actor: Actor,
  tripId: string,
  input: PricingPolicyInput
): Promise<Result<TripCostingDto>> {
  if (input.marginValue < 0) return fail('VALIDATION_FAILED', { field: 'marginValue' });
  // A manual price of zero or less is as meaningless as a free budget line;
  // `!input.manualPricePerSeatCents` also catches `undefined`, which is the
  // normal shape of "the administrator switched to MANUAL without typing a
  // price yet".
  if (input.priceMode === 'MANUAL' && !(input.manualPricePerSeatCents && input.manualPricePerSeatCents > 0)) {
    return fail('VALIDATION_FAILED', { field: 'manualPricePerSeatCents' });
  }

  const existing = await db.trip.findUnique({ where: { id: tripId } });
  if (!existing) return fail('NOT_FOUND');

  return db.$transaction(async (tx) => {
    // Deliberately does not touch `pricePerSeatCents` (or `budgetTotalCents`):
    // those are the trip's money columns, and `persistCosting` below is their
    // only writer. A freshly-typed manual price still has to reach the
    // database, so it travels as that call's `manualPriceOverride` argument
    // instead of being written here first.
    await tx.trip.update({
      where: { id: tripId },
      data: {
        marginMode: input.marginMode,
        marginValue: input.marginValue,
        priceMode: input.priceMode,
      },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.pricing_policy_changed',
      entityType: 'Trip',
      entityId: tripId,
      before: {
        marginMode: existing.marginMode,
        marginValue: existing.marginValue,
        priceMode: existing.priceMode,
        pricePerSeatCents: existing.pricePerSeatCents,
      },
      after: input,
    });
    return persistCosting(tx, tripId, input.priceMode === 'MANUAL' ? input.manualPricePerSeatCents : undefined);
  });
}
