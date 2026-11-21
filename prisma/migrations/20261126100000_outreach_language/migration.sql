-- Outreach language (English / Spanish markets): on leads, and as an optional condition on allocation rules.
ALTER TABLE "leads" ADD COLUMN "outreach_language" CHAR(2) NOT NULL DEFAULT 'en';
ALTER TABLE "allocation_rules" ADD COLUMN "match_language" CHAR(2);
