-- Import leads + Data manager: batches, their uploaded files and staged rows (kept as the record after import).
-- Additive only. The unused "enrichment_settings"."claude_monthly_cap_usd" column is still left in place (see
-- docs/MIGRATIONS.md), so the schema diff's DROP COLUMN for it is deliberately not part of this migration.

-- CreateTable
CREATE TABLE "import_batches" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "language" CHAR(2) NOT NULL,
    "lead_type" VARCHAR(10) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Uploading',
    "created_by_id" INTEGER,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "new_company_count" INTEGER NOT NULL DEFAULT 0,
    "existing_company_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "research_total" INTEGER NOT NULL DEFAULT 0,
    "research_done" INTEGER NOT NULL DEFAULT 0,
    "research_paused" BOOLEAN NOT NULL DEFAULT false,
    "research_stop_reason" VARCHAR(20),
    "research_started_at" TIMESTAMP(3),
    "research_engine" VARCHAR(120),
    "activity" JSONB NOT NULL DEFAULT '[]',
    "options" JSONB NOT NULL DEFAULT '{}',
    "imported_at" TIMESTAMP(3),
    "imported_by_id" INTEGER,
    "undone_at" TIMESTAMP(3),
    "undone_by_id" INTEGER,
    "undo" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_files" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "ext" VARCHAR(5) NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_path" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Reading',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "error" VARCHAR(200),
    "column_map" JSONB NOT NULL DEFAULT '{}',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "claude_calls" INTEGER NOT NULL DEFAULT 0,
    "read_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "file_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "sheet" VARCHAR(100),
    "origin_kind" VARCHAR(5) NOT NULL,
    "origin_n" INTEGER NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '[]',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "edited" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL,
    "include" BOOLEAN NOT NULL,
    "include_touched" BOOLEAN NOT NULL DEFAULT false,
    "matched_company_id" INTEGER,
    "problems" JSONB NOT NULL DEFAULT '[]',
    "research" JSONB NOT NULL DEFAULT '{}',
    "research_status" VARCHAR(12),
    "research_note" VARCHAR(300),
    "researched_at" TIMESTAMP(3),
    "claude_at" TIMESTAMP(3),
    "outcome" VARCHAR(10),
    "outcome_code" VARCHAR(30),
    "error" VARCHAR(300),
    "lead_id" INTEGER,
    "company_id" INTEGER,
    "contact_id" INTEGER,
    "company_created" BOOLEAN NOT NULL DEFAULT false,
    "contact_created" BOOLEAN NOT NULL DEFAULT false,
    "stamps" JSONB,
    "imported_at" TIMESTAMP(3),

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_number_key" ON "import_batches"("number");

-- CreateIndex
CREATE INDEX "import_batches_status_idx" ON "import_batches"("status");

-- CreateIndex
CREATE INDEX "import_batches_created_at_idx" ON "import_batches"("created_at");

-- CreateIndex
CREATE INDEX "import_files_batch_id_idx" ON "import_files"("batch_id");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_position_idx" ON "import_rows"("batch_id", "position");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_status_idx" ON "import_rows"("batch_id", "status");

-- CreateIndex
CREATE INDEX "import_rows_file_id_idx" ON "import_rows"("file_id");

-- CreateIndex
CREATE INDEX "import_rows_claude_at_idx" ON "import_rows"("claude_at");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_undone_by_id_fkey" FOREIGN KEY ("undone_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "import_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_matched_company_id_fkey" FOREIGN KEY ("matched_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

