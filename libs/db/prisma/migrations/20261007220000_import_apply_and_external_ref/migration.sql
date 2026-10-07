-- AlterEnum
ALTER TYPE "ImportStatus" ADD VALUE 'APPLYING';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "external_ref" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_ref_key" ON "payments"("external_ref");

