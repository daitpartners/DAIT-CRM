-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "draft_files" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "quoted_html" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "note" TEXT,
ADD COLUMN     "priority" VARCHAR(6) NOT NULL DEFAULT 'normal';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "signature_auto" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "signature_html" TEXT;
