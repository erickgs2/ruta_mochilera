-- At most one OVERPAYMENT entry per payment. Only the webhook delivery that
-- wins the conditional PENDING -> SUCCEEDED update ever writes one, so the
-- normal path never reaches this index; it is the net that turns a second
-- write into an aborted transaction instead of money credited twice.
-- Partial, so it says nothing about the other kinds: a cancelled
-- reservation's late payment carries both a CANCELLATION and an OVERPAYMENT
-- entry with the same payment_id. Prisma cannot express a partial index;
-- the CreditEntryKind enum carries a comment pointing here.
CREATE UNIQUE INDEX "customer_credit_entries_overpayment_payment_id_key"
  ON "customer_credit_entries" ("payment_id")
  WHERE "kind" = 'OVERPAYMENT';
