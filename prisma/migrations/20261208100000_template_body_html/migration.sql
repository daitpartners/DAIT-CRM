-- Formatted (HTML) email templates (owner, 24 Nov 2026): the sanitised HTML of a template read from an Outlook .oft
-- (or written in the formatted editor), and the copy a Mailer campaign keeps when it is queued. Nullable: a template
-- or campaign without it is plain text, as before. Adds two columns only.

ALTER TABLE "email_templates" ADD COLUMN "body_html" TEXT;

ALTER TABLE "email_campaigns" ADD COLUMN "body_html" TEXT;
