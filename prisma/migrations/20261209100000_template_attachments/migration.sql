-- Template pictures and attachments (owner, 24 Nov 2026): the inline pictures (cid:) and regular attachments of an
-- uploaded .oft, stored on disk under STORAGE_DIR (paths hold ids only) and listed here; and the copy a Mailer campaign
-- keeps when it is queued. Adds one table and one defaulted column.

CREATE TABLE "email_template_attachments" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "size" INTEGER NOT NULL,
    "content_id" VARCHAR(200),
    "is_inline" BOOLEAN NOT NULL DEFAULT false,
    "storage_path" VARCHAR(255) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_template_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_template_attachments_template_id_idx" ON "email_template_attachments"("template_id");

ALTER TABLE "email_template_attachments" ADD CONSTRAINT "email_template_attachments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_campaigns" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
