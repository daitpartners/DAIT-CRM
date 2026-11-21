-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "unsubscribed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "bcc_addresses" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "campaign_id" INTEGER;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "do_not_email" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "email_campaigns" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "template_id" INTEGER,
    "template_name" VARCHAR(150) NOT NULL,
    "template_updated_at" TIMESTAMP(3),
    "subject" VARCHAR(500) NOT NULL,
    "body" TEXT NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "account_id" INTEGER,
    "sender_address" TEXT NOT NULL,
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "start_at" TIMESTAMP(3),
    "interval_minutes" INTEGER NOT NULL,
    "working_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribe_line" BOOLEAN NOT NULL DEFAULT true,
    "lawful_basis" VARCHAR(160) NOT NULL,
    "status" TEXT NOT NULL,
    "pause_reason" TEXT,
    "wait_reason" TEXT,
    "next_send_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "cancelled_by_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_campaign_recipients" (
    "id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "contact_id" INTEGER,
    "to_address" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "company" TEXT NOT NULL DEFAULT '',
    "timezones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone_source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3),
    "email_message_id" INTEGER,
    "error" TEXT,

    CONSTRAINT "email_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_campaigns_status_next_send_at_idx" ON "email_campaigns"("status", "next_send_at");

-- CreateIndex
CREATE INDEX "email_campaigns_sender_id_created_at_idx" ON "email_campaigns"("sender_id", "created_at");

-- CreateIndex
CREATE INDEX "email_campaign_recipients_campaign_id_status_position_idx" ON "email_campaign_recipients"("campaign_id", "status", "position");

-- CreateIndex
CREATE INDEX "email_campaign_recipients_lead_id_idx" ON "email_campaign_recipients"("lead_id");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

