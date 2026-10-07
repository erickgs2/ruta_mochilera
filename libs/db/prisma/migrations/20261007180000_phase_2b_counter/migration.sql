-- CreateEnum
CREATE TYPE "CreditEntryKind" AS ENUM ('CANCELLATION', 'PRICE_DECREASE', 'APPLIED', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PasswordResetPurpose" AS ENUM ('RESET', 'INVITATION');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('CUSTOMERS', 'PAYMENTS');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('VALIDATED', 'APPLIED', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CREDIT';

-- AlterTable
ALTER TABLE "password_resets" ADD COLUMN     "purpose" "PasswordResetPurpose" NOT NULL DEFAULT 'RESET';

-- AlterTable
ALTER TABLE "reservations" DROP COLUMN "credit_cents";

-- CreateTable
CREATE TABLE "receipt_counters" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "customer_credit_entries" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "kind" "CreditEntryKind" NOT NULL,
    "reservation_id" UUID,
    "payment_id" UUID,
    "reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_price_changes" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "previous_total_cents" INTEGER NOT NULL,
    "new_total_cents" INTEGER NOT NULL,
    "notice_es" TEXT NOT NULL,
    "notice_en" TEXT,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "type" "ImportType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "rows_total" INTEGER NOT NULL,
    "rows_ok" INTEGER NOT NULL,
    "rows_failed" INTEGER NOT NULL,
    "report" JSONB NOT NULL,
    "send_emails" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_credit_entries_customer_id_created_at_idx" ON "customer_credit_entries"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_credit_entries_reservation_id_idx" ON "customer_credit_entries"("reservation_id");

-- CreateIndex
CREATE INDEX "reservation_price_changes_reservation_id_idx" ON "reservation_price_changes"("reservation_id");

-- CreateIndex
CREATE INDEX "import_batches_created_at_idx" ON "import_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments"("receipt_number");

-- AddForeignKey
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_price_changes" ADD CONSTRAINT "reservation_price_changes_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_price_changes" ADD CONSTRAINT "reservation_price_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A credit entry always moves money: a zero-amount row would be noise in the
-- ledger. Prisma cannot express a CHECK, hence raw SQL.
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_amount_not_zero" CHECK ("amount_cents" <> 0);
