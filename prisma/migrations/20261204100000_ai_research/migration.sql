-- Release 4 AI research: runs, suggestions, source records, single-row engine settings; "Not started" research status.
-- AlterTable
ALTER TABLE "companies" ALTER COLUMN "ai_research_status" SET DEFAULT 'Not started';

-- CreateTable
CREATE TABLE "enrichment_runs" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "trigger" VARCHAR(120) NOT NULL,
    "engine" VARCHAR(120) NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "result" TEXT NOT NULL DEFAULT '',
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Pending',
    "error" TEXT,
    "cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "places_calls" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_suggestions" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "field" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "display" TEXT,
    "confidence" SMALLINT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_label" VARCHAR(200) NOT NULL,
    "decision" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "enrichment_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_records" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "title" VARCHAR(200) NOT NULL,
    "url" VARCHAR(500),
    "source_type" VARCHAR(40) NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collected_by" VARCHAR(120) NOT NULL,
    "fields_populated" VARCHAR(500) NOT NULL DEFAULT '',
    "confidence" VARCHAR(20) NOT NULL DEFAULT '',
    "snapshot" TEXT,

    CONSTRAINT "source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "daily_run_limit" INTEGER NOT NULL DEFAULT 50,
    "claude_enabled" BOOLEAN NOT NULL DEFAULT false,
    "claude_monthly_cap_usd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "places_enabled" BOOLEAN NOT NULL DEFAULT false,
    "places_monthly_call_cap" INTEGER NOT NULL DEFAULT 0,
    "web_search_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrichment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrichment_runs_company_id_created_at_idx" ON "enrichment_runs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "enrichment_runs_created_at_idx" ON "enrichment_runs"("created_at");

-- CreateIndex
CREATE INDEX "enrichment_suggestions_run_id_idx" ON "enrichment_suggestions"("run_id");

-- CreateIndex
CREATE INDEX "enrichment_suggestions_company_id_decision_idx" ON "enrichment_suggestions"("company_id", "decision");

-- CreateIndex
CREATE INDEX "source_records_company_id_collected_at_idx" ON "source_records"("company_id", "collected_at");

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_suggestions" ADD CONSTRAINT "enrichment_suggestions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_suggestions" ADD CONSTRAINT "enrichment_suggestions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_suggestions" ADD CONSTRAINT "enrichment_suggestions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: a company never researched is "Not started" ("Pending" now means queued).
UPDATE "companies" SET "ai_research_status" = 'Not started' WHERE "ai_last_research_at" IS NULL;

-- Enrichment settings is a single row.
ALTER TABLE "enrichment_settings" ADD CONSTRAINT "enrichment_settings_single_row" CHECK ("id" = 1);

-- Seed: ENRICHMENT_SETTINGS_DEFAULTS (shared) — everything that costs money is off.
INSERT INTO "enrichment_settings" ("id", "daily_run_limit", "claude_enabled", "claude_monthly_cap_usd", "places_enabled", "places_monthly_call_cap", "web_search_enabled", "updated_at")
VALUES (1, 50, false, 0, false, 0, false, CURRENT_TIMESTAMP);
