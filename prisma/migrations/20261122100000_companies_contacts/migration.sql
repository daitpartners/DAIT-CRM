-- Company numbers CO-0001, CO-0002, ...: the sequence must exist before companies.number's default uses it.
CREATE SEQUENCE company_number_seq START 1;

-- CreateTable
CREATE TABLE "companies" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL DEFAULT ('CO-'::text || lpad((nextval('company_number_seq'::regclass))::text, 4, '0'::text)),
    "name" TEXT NOT NULL,
    "name_normalised" TEXT NOT NULL,
    "legal_name" TEXT,
    "website" TEXT,
    "domain" TEXT,
    "business_email" TEXT,
    "industry" TEXT,
    "business_category" TEXT,
    "business_type" TEXT,
    "year_established" SMALLINT,
    "description" TEXT,
    "logo_path" TEXT,
    "linkedin_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "is_client" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "city" TEXT,
    "street" TEXT,
    "zip" TEXT,
    "timezone" TEXT,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "maps_url" TEXT,
    "employee_count" INTEGER,
    "employee_range" TEXT,
    "annual_revenue" DECIMAL(18,2),
    "revenue_currency" CHAR(3),
    "revenue_range" TEXT,
    "ownership_type" TEXT,
    "registration_number" TEXT,
    "stock_exchange" TEXT,
    "stock_symbol" TEXT,
    "main_products" TEXT,
    "main_services" TEXT,
    "business_verticals" JSONB NOT NULL DEFAULT '[]',
    "target_markets" JSONB NOT NULL DEFAULT '[]',
    "geographic_markets" JSONB NOT NULL DEFAULT '[]',
    "key_brands" TEXT,
    "specialisation" TEXT,
    "social_facebook" TEXT,
    "social_instagram" TEXT,
    "social_x" TEXT,
    "social_youtube" TEXT,
    "social_other" TEXT,
    "website_technology" TEXT,
    "website_assessment" TEXT,
    "digital_summary" TEXT,
    "ai_summary" TEXT,
    "ai_industry" TEXT,
    "ai_business_category" TEXT,
    "ai_potential_services" JSONB NOT NULL DEFAULT '[]',
    "ai_opportunity_score" SMALLINT,
    "ai_confidence" TEXT,
    "ai_research_status" TEXT NOT NULL DEFAULT 'Pending',
    "ai_last_research_at" TIMESTAMP(3),
    "verification_status" TEXT NOT NULL DEFAULT 'Unverified',
    "verified_fields" JSONB NOT NULL DEFAULT '{}',
    "ai_fields" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "business_email" TEXT,
    "phone" TEXT,
    "phone_normalised" TEXT,
    "mobile" TEXT,
    "mobile_normalised" TEXT,
    "linkedin_url" TEXT,
    "contact_type" TEXT NOT NULL DEFAULT 'Other',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_locations" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "location_type" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "city" TEXT,
    "street" TEXT,
    "zip" TEXT,
    "timezone" TEXT,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "maps_url" TEXT,
    "phone" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'Manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_number_key" ON "companies"("number");

-- CreateIndex
CREATE UNIQUE INDEX "companies_domain_key" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "companies_name_idx" ON "companies"("name");

-- CreateIndex
CREATE INDEX "companies_name_normalised_country_idx" ON "companies"("name_normalised", "country");

-- CreateIndex
CREATE INDEX "companies_country_idx" ON "companies"("country");

-- CreateIndex
CREATE INDEX "companies_status_idx" ON "companies"("status");

-- CreateIndex
CREATE INDEX "companies_registration_number_idx" ON "companies"("registration_number");

-- CreateIndex
CREATE INDEX "contacts_business_email_idx" ON "contacts"("business_email");

-- CreateIndex
CREATE INDEX "contacts_phone_normalised_idx" ON "contacts"("phone_normalised");

-- CreateIndex
CREATE INDEX "contacts_mobile_normalised_idx" ON "contacts"("mobile_normalised");

-- CreateIndex
CREATE INDEX "contacts_company_id_last_name_idx" ON "contacts"("company_id", "last_name");

-- CreateIndex
CREATE INDEX "company_locations_company_id_idx" ON "company_locations"("company_id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop the sequence with the column.
ALTER SEQUENCE company_number_seq OWNED BY companies.number;

-- At most one primary contact per company.
CREATE UNIQUE INDEX contacts_one_primary_per_company ON contacts (company_id) WHERE is_primary;
