-- Release 2A: personal mailboxes next to the system mailbox, and team email templates.

-- The same address may be stored once as the system mailbox and once as a personal mailbox.
DROP INDEX "email_accounts_address_key";
CREATE UNIQUE INDEX "email_accounts_address_kind_key" ON "email_accounts"("address", "kind");

ALTER TABLE "email_accounts"
  ADD COLUMN "sync_mail" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sync_calendar" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "shared_mailboxes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "last_sync_at" TIMESTAMP(3),
  ADD COLUMN "message_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "email_templates" (
  "id" SERIAL NOT NULL,
  "name" VARCHAR(150) NOT NULL,
  "language" CHAR(2) NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "source_type" TEXT NOT NULL,
  "file_name" VARCHAR(255),
  "file_size" INTEGER,
  "created_by" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
