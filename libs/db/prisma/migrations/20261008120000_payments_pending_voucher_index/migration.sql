-- The counter's "vouchers to chase" queue reads PENDING payments by voucher
-- expiry. Partial, because almost every payment ends up SUCCEEDED or EXPIRED
-- and the queue only ever looks at the few still waiting. Prisma has no syntax
-- for a partial index, so it is not in schema.prisma (same as
-- reservations_live_trip_customer_key).
CREATE INDEX "payments_pending_voucher_expires_idx" ON "payments"("voucher_expires_at") WHERE "status" = 'PENDING';
