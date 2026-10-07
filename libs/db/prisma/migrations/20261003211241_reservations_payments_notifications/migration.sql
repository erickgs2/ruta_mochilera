-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('APP', 'BRANCH', 'IMPORT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'OXXO', 'SPEI', 'CASH', 'LEGACY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'MANUAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'INBOX');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "accepted_terms_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "hold_expires_at" TIMESTAMPTZ,
    "total_price_cents" INTEGER NOT NULL,
    "minimum_deposit_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_cents" INTEGER NOT NULL DEFAULT 0,
    "payment_deadline" DATE NOT NULL,
    "source" "ReservationSource" NOT NULL,
    "created_by" UUID,
    "cancellation_requested_at" TIMESTAMPTZ,
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "is_backfilled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" "PaymentProvider" NOT NULL,
    "provider_intent_id" TEXT,
    "provider_voucher_url" TEXT,
    "voucher_expires_at" TIMESTAMPTZ,
    "receipt_number" TEXT,
    "receipt_key" TEXT,
    "receipt_sent_at" TIMESTAMPTZ,
    "recorded_by" UUID,
    "is_backfilled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("stripe_event_id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "rendered_title" TEXT NOT NULL,
    "rendered_body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_code_key" ON "reservations"("code");

-- CreateIndex
CREATE INDEX "reservations_trip_id_idx" ON "reservations"("trip_id");

-- CreateIndex
CREATE INDEX "reservations_customer_id_idx" ON "reservations"("customer_id");

-- CreateIndex
CREATE INDEX "payments_reservation_id_idx" ON "payments"("reservation_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_user_id_created_at_idx" ON "notification_deliveries"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: at most one live (HELD or ACTIVE) reservation per
-- customer per trip. Prisma cannot express a partial index in schema.prisma,
-- so this is written by hand. A CANCELLED or EXPIRED reservation is excluded
-- by the WHERE clause and never blocks a new reservation for the same pair.
CREATE UNIQUE INDEX "reservations_live_trip_customer_key" ON "reservations"("trip_id", "customer_id") WHERE "status" IN ('HELD', 'ACTIVE');
