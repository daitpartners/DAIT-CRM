-- Download all leads + update through Import leads (owner, 24 Nov 2026): an import row carrying a Lead ID / Company ID
-- fills that record's blanks; what it filled (for Undo) and the values it did not apply (conflicts, listed in the
-- rows-to-fix download) are kept on the row. Nullable: every other row has none. Adds one column only.

ALTER TABLE "import_rows" ADD COLUMN "changes" JSONB;
