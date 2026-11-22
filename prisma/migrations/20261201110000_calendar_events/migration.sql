-- Release 3C: a private copy of each user's Outlook calendar (Sync calendar on a connected personal mailbox).
-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "calendar_sync_at" TIMESTAMP(3),
ADD COLUMN     "calendar_sync_state" JSONB;

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "graph_id" TEXT NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "is_all_day" BOOLEAN NOT NULL DEFAULT false,
    "location" VARCHAR(500),
    "organizer_name" VARCHAR(255),
    "organizer_address" VARCHAR(320),
    "attendee_addresses" JSONB NOT NULL DEFAULT '[]',
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "lead_id" INTEGER,
    "company_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_events_user_id_starts_at_idx" ON "calendar_events"("user_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_events_account_id_idx" ON "calendar_events"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_user_id_graph_id_key" ON "calendar_events"("user_id", "graph_id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

