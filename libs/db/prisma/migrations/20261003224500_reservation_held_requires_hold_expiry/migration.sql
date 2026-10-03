-- A HELD reservation must carry the moment its hold runs out.
--
-- `hold_expires_at` is nullable because ACTIVE clears it on purpose: once the
-- minimum deposit is covered the seat stops being a hold and stops expiring
-- (business rule 5.3). Nothing, however, tied the *other* direction, so a HELD
-- row with a NULL expiry was representable -- a hold that never runs out, and
-- that the seat count reads as free, because `hold_expires_at > now()` is not
-- true for NULL. The seat would be taken and sellable at the same time: a
-- silent oversell inside the one calculation whose job is to prevent it.
--
-- Stated as a one-directional implication (HELD => NOT NULL) rather than an
-- equivalence: CANCELLED and EXPIRED rows keep whatever expiry they had, which
-- is history worth preserving, and ACTIVE rows are expected to have none.
--
-- Prisma cannot express a CHECK constraint in `schema.prisma`, so this is
-- written by hand, the same way the `reservations_live_trip_customer_key`
-- partial index is in the `reservations_payments_notifications` migration.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_held_requires_hold_expiry"
  CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL);
