-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "sync_state" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "attachment_names" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "from_name" VARCHAR(255),
ADD COLUMN     "graph_id" VARCHAR(255),
ADD COLUMN     "logged_at" TIMESTAMP(3),
ADD COLUMN     "reply_to_id" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'crm';

-- CreateIndex
CREATE INDEX "email_messages_user_id_thread_id_idx" ON "email_messages"("user_id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_user_id_graph_id_key" ON "email_messages"("user_id", "graph_id");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

