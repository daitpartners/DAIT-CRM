-- Release 3B: projects, primary stakeholders, email_messages.project_id, and the real relation for quotations.project_id.
-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "project_id" INTEGER;

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "company_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "quotation_id" INTEGER,
    "name" VARCHAR(200) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "start_date" DATE NOT NULL,
    "value" DECIMAL(14,2),
    "currency" VARCHAR(3) NOT NULL,
    "manager_id" INTEGER NOT NULL,
    "description" TEXT,
    "created_by_id" INTEGER NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stakeholders" (
    "project_id" INTEGER NOT NULL,
    "contact_id" INTEGER NOT NULL,

    CONSTRAINT "project_stakeholders_pkey" PRIMARY KEY ("project_id","contact_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_number_key" ON "projects"("number");

-- CreateIndex
CREATE UNIQUE INDEX "projects_quotation_id_key" ON "projects"("quotation_id");

-- CreateIndex
CREATE INDEX "projects_company_id_idx" ON "projects"("company_id");

-- CreateIndex
CREATE INDEX "projects_lead_id_idx" ON "projects"("lead_id");

-- CreateIndex
CREATE INDEX "projects_manager_id_idx" ON "projects"("manager_id");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "project_stakeholders_contact_id_idx" ON "project_stakeholders"("contact_id");

-- CreateIndex
CREATE INDEX "email_messages_user_id_project_id_idx" ON "email_messages"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "quotations_project_id_idx" ON "quotations"("project_id");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- quotations.project_id was a plain column until now and nothing set it; projects is empty, so any value would be an
-- orphan the foreign key rejects. Clear such values (expected: none; existing NULLs stay NULL).
UPDATE "quotations" SET "project_id" = NULL WHERE "project_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

