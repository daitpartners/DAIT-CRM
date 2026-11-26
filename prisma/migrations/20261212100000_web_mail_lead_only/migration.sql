-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "lead_deleted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "mail_backfills" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "next_link" TEXT,
    "found" INTEGER NOT NULL DEFAULT 0,
    "stored" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_backfills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_backfill_addresses" (
    "address" VARCHAR(320) NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_backfill_addresses_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE INDEX "mail_backfills_status_id_idx" ON "mail_backfills"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_backfills_account_id_address_key" ON "mail_backfills"("account_id", "address");

-- AddForeignKey
ALTER TABLE "mail_backfills" ADD CONSTRAINT "mail_backfills_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

