-- Email reader shows formatted mail (owner, 23 Nov 2026): the sanitised HTML body beside the text one.
-- Nullable: existing rows get it when first opened, from the owner's own mailbox.
ALTER TABLE "email_messages" ADD COLUMN "body_html" TEXT;
