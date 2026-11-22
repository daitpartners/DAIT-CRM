-- Release 3A: quotations (working-copy lines, frozen revisions), single-row Company details, tasks.quotation_id relation.
-- CreateTable
CREATE TABLE "quotations" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "company_id" INTEGER NOT NULL,
    "contact_id" INTEGER,
    "lead_id" INTEGER,
    "owner_id" INTEGER NOT NULL,
    "quotation_date" DATE NOT NULL,
    "valid_until" DATE,
    "currency" VARCHAR(3) NOT NULL,
    "subject" VARCHAR(300) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "overall_discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "editing_new_revision" BOOLEAN NOT NULL DEFAULT false,
    "sending_message_id" INTEGER,
    "project_id" INTEGER,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" SERIAL NOT NULL,
    "quotation_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "item" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_revisions" (
    "id" SERIAL NOT NULL,
    "quotation_id" INTEGER NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "sent_to" VARCHAR(320) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount_total" DECIMAL(14,2) NOT NULL,
    "tax_total" DECIMAL(14,2) NOT NULL,
    "grand_total" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "legal_name" VARCHAR(200) NOT NULL,
    "address_lines" JSONB NOT NULL DEFAULT '[]',
    "email" VARCHAR(255) NOT NULL,
    "gstin" VARCHAR(15),
    "tax_inr" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "tax_usd" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_cad" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "default_notes" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotations_number_key" ON "quotations"("number");

-- CreateIndex
CREATE INDEX "quotations_company_id_idx" ON "quotations"("company_id");

-- CreateIndex
CREATE INDEX "quotations_lead_id_idx" ON "quotations"("lead_id");

-- CreateIndex
CREATE INDEX "quotations_owner_id_idx" ON "quotations"("owner_id");

-- CreateIndex
CREATE INDEX "quotations_status_idx" ON "quotations"("status");

-- CreateIndex
CREATE INDEX "quotations_quotation_date_idx" ON "quotations"("quotation_date");

-- CreateIndex
CREATE INDEX "quotation_lines_quotation_id_sort_order_idx" ON "quotation_lines"("quotation_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_revisions_quotation_id_revision_no_key" ON "quotation_revisions"("quotation_id", "revision_no");

-- CreateIndex
CREATE INDEX "tasks_quotation_id_idx" ON "tasks"("quotation_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_sending_message_id_fkey" FOREIGN KEY ("sending_message_id") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "quotation_revisions_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Company details is a single row.
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_single_row" CHECK ("id" = 1);

-- Seed: the issuer printed on every quotation (owner, 22 Nov 2026); default terms = the prototype's with VAT → GST.
INSERT INTO "company_settings" ("id", "legal_name", "address_lines", "email", "gstin", "tax_inr", "tax_usd", "tax_cad", "default_notes", "updated_at")
VALUES (
    1,
    'DAIT Partners LLP',
    '["D-303, Sagar Sadan", "IP Extension", "Delhi 110092", "India"]',
    'info@daitpartners.com',
    NULL,
    18,
    0,
    0,
    'Payment: 40% on acceptance, 40% at milestone, 20% on completion. Prices exclude GST where applicable.',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
