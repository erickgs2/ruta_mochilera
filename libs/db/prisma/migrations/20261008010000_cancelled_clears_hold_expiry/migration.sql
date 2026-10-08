-- A cancelled reservation has no hold: cancelReservation now clears
-- hold_expires_at, so bring the rows cancelled before that in line.
-- reservations_held_requires_hold_expiry only constrains HELD rows, so this is safe.
UPDATE "reservations" SET "hold_expires_at" = NULL WHERE "status" = 'CANCELLED' AND "hold_expires_at" IS NOT NULL;
