-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "flag_due" DATE,
ADD COLUMN     "flag_status" VARCHAR(12) NOT NULL DEFAULT 'notFlagged',
ADD COLUMN     "size_bytes" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "email_messages_user_id_flag_status_idx" ON "email_messages"("user_id", "flag_status");

-- Back-fill size from the stored body length
UPDATE "email_messages" SET "size_bytes" = octet_length(coalesce("body_html", "body_text"));
