import type { Db } from '@rm/db';
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

/**
 * Single source of truth for the trip's money columns (`budget_total_cents` and
 * `price_per_seat_cents`). Every mutation that can change the sale price --
 * adding, editing or deleting a budget item, or changing the margin/price
 * policy -- ends by calling this, and nothing else in this file writes those
 * two columns. That is what keeps them from ever drifting out of sync with the
 * budget items that produced them: there is exactly one place that computes
 * and persists them.
 *
 * Editing the budget of an already-published trip re-prices the trip itself
 * through this same function, but Phase 1 has no `Reservation` model yet, so
 * there is nothing here that could touch one. Once reservations exist
 * (Phase 2), they freeze their own total at booking time and this function
 * must keep not touching them -- propagating a new price to existing
 * reservations is a deliberate, separate operation, not a side effect of
 * editing a budget line.
 *
 * `manualPriceOverride` exists solely for `setPricingPolicy`: the moment an
 * administrator types a new manual price, that number has to land in
 * `price_per_seat_cents` somehow, and this parameter is how it gets there --
 * through this function's own write, rather than `setPricingPolicy` writing
 * the column itself first and this function silently repeating the same
 * value. When omitted, MANUAL falls back to whatever price is already stored
 * (the normal case: a budget item changed, not the price policy itself).
 */
async function recomputeAndPersist(
  db: Db,
  tripId: string,
  manualPriceOverride?: number
): Promise<Result<TripCostingDto>> {
  const trip = await db.trip.findUnique({ where: { id: tripId }, include: { budgetItems: true } });
  if (!trip) return fail('NOT_FOUND');

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

  await db.trip.update({
    where: { id: tripId },
    data: { budgetTotalCents: pricing.value.budgetTotalCents, pricePerSeatCents },
  });

  return ok({
    tripId,
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
 * Returns the trip's full costing picture -- not just the line items, since
 * the costing screen always needs the total, the margin and the price
 * alongside the list, and this goes through `recomputeAndPersist` so that
 * view is never stale relative to what is stored.
 */
export async function listBudgetItems(db: Db, tripId: string): Promise<Result<TripCostingDto>> {
  return recomputeAndPersist(db, tripId);
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

  await db.$transaction(async (tx) => {
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
  });

  return recomputeAndPersist(db, tripId);
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

  await db.$transaction(async (tx) => {
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
  });

  return recomputeAndPersist(db, existing.tripId);
}

export async function deleteBudgetItem(
  db: Db,
  actor: Actor,
  itemId: string
): Promise<Result<TripCostingDto>> {
  const existing = await db.tripBudgetItem.findUnique({ where: { id: itemId } });
  if (!existing) return fail('NOT_FOUND');

  await db.$transaction(async (tx) => {
    await tx.tripBudgetItem.delete({ where: { id: itemId } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'trip.budget_item_deleted',
      entityType: 'TripBudgetItem',
      entityId: itemId,
      before: { concept: existing.concept, unitAmountCents: existing.unitAmountCents },
    });
  });

  return recomputeAndPersist(db, existing.tripId);
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

  await db.$transaction(async (tx) => {
    // Deliberately does not touch `pricePerSeatCents` (or `budgetTotalCents`):
    // those are the trip's money columns, and `recomputeAndPersist` below is
    // their only writer. A freshly-typed manual price still has to reach the
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
  });

  return recomputeAndPersist(
    db,
    tripId,
    input.priceMode === 'MANUAL' ? input.manualPricePerSeatCents : undefined
  );
}
