-- AlterEnum
-- OVERPAYMENT: the part of a provider-confirmed payment above what its
-- reservation still owed becomes the customer's credit (owner decision D7).
-- Its own migration because PostgreSQL does not let a new enum value be used
-- in the same transaction that adds it, and the next migration's index does.
ALTER TYPE "CreditEntryKind" ADD VALUE 'OVERPAYMENT';
