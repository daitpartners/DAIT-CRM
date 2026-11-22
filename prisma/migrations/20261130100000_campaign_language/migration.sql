-- The campaign keeps its template's language (for the opt-out line) even when the template is deleted.
ALTER TABLE "email_campaigns" ADD COLUMN "language" VARCHAR(5) NOT NULL DEFAULT 'en';

UPDATE "email_campaigns" c SET "language" = t."language" FROM "email_templates" t WHERE c."template_id" = t."id";
