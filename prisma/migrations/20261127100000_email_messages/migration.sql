-- Release 2B-1: a user's email messages (sent from the CRM now; synced in 2B-2). Private to user_id.
CREATE TABLE "email_messages" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "account_id" INTEGER,
  "lead_id" INTEGER,
  "contact_id" INTEGER,
  "company_id" INTEGER,
  "folder" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "from_address" TEXT NOT NULL,
  "to_addresses" JSONB NOT NULL DEFAULT '[]',
  "cc_addresses" JSONB NOT NULL DEFAULT '[]',
  "subject" VARCHAR(500) NOT NULL,
  "body_text" TEXT NOT NULL DEFAULT '',
  "message_id" VARCHAR(255),
  "thread_id" VARCHAR(255),
  "is_read" BOOLEAN NOT NULL DEFAULT true,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_messages_user_id_lead_id_idx" ON "email_messages"("user_id", "lead_id");
CREATE INDEX "email_messages_user_id_folder_occurred_at_idx" ON "email_messages"("user_id", "folder", "occurred_at");
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
