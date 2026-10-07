-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "cancellation_decline_reason" TEXT,
ADD COLUMN     "cancellation_declined_at" TIMESTAMPTZ,
ADD COLUMN     "cancellation_declined_by" UUID;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancellation_declined_by_fkey" FOREIGN KEY ("cancellation_declined_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
