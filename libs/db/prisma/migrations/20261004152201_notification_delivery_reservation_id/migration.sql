-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "reservation_id" UUID;

-- CreateIndex
CREATE INDEX "notification_deliveries_reservation_id_event_type_idx" ON "notification_deliveries"("reservation_id", "event_type");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
