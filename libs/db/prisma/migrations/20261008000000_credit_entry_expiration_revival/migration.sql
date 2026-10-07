-- AlterEnum
-- EXPIRATION: the money an expired hold had received becomes the customer's credit.
-- REVIVAL: that credit is taken back when staff revive the expired reservation.
ALTER TYPE "CreditEntryKind" ADD VALUE 'EXPIRATION';
ALTER TYPE "CreditEntryKind" ADD VALUE 'REVIVAL';
