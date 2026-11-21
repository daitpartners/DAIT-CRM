-- Lead numbers: LD-1001, LD-1002, ... (no padding). Created before the table so the column default resolves.
CREATE SEQUENCE lead_number_seq START 1001;

CREATE FUNCTION next_lead_number() RETURNS text LANGUAGE sql AS
$$ SELECT 'LD-' || n::text FROM (SELECT nextval('lead_number_seq') AS n) s $$;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL DEFAULT next_lead_number(),
    "lead_type" TEXT NOT NULL DEFAULT 'Lead',
    "company_name" TEXT NOT NULL,
    "company_id" INTEGER,
    "contact_id" INTEGER,
    "website" TEXT,
    "business_email" TEXT,
    "phone" TEXT,
    "country" TEXT NOT NULL,
    "city" TEXT,
    "lead_source" TEXT NOT NULL,
    "source_url" TEXT,
    "import_batch" TEXT,
    "assigned_to_id" INTEGER,
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "status" TEXT NOT NULL DEFAULT 'New',
    "next_follow_up" DATE,
    "notes" TEXT,
    "enquiry_id" INTEGER,
    "enrichment_status" TEXT NOT NULL DEFAULT 'Pending',
    "converted_to" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "activity_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "status_from" TEXT,
    "status_to" TEXT,
    "related_type" TEXT,
    "related_id" INTEGER,
    "by_user_id" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "from_user_id" INTEGER,
    "to_user_id" INTEGER,
    "by_user_id" INTEGER,
    "rule_id" INTEGER,
    "note" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER,
    "quotation_id" INTEGER,
    "title" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "assigned_to_id" INTEGER NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "closed_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_number_key" ON "leads"("number");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_assigned_to_id_idx" ON "leads"("assigned_to_id");

-- CreateIndex
CREATE INDEX "leads_company_id_idx" ON "leads"("company_id");

-- CreateIndex
CREATE INDEX "leads_lead_type_idx" ON "leads"("lead_type");

-- CreateIndex
CREATE INDEX "leads_next_follow_up_idx" ON "leads"("next_follow_up");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE INDEX "leads_country_idx" ON "leads"("country");

-- CreateIndex
CREATE INDEX "lead_activities_lead_id_occurred_at_idx" ON "lead_activities"("lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_assignments_lead_id_assigned_at_idx" ON "lead_assignments"("lead_id", "assigned_at");

-- CreateIndex
CREATE INDEX "tasks_assigned_to_id_is_done_due_date_idx" ON "tasks"("assigned_to_id", "is_done", "due_date");

-- CreateIndex
CREATE INDEX "tasks_lead_id_origin_is_done_idx" ON "tasks"("lead_id", "origin", "is_done");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "allocation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the sequence with the column.
ALTER SEQUENCE lead_number_seq OWNED BY leads.number;
