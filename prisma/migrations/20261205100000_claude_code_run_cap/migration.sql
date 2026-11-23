-- Claude runs through the server's Claude Code (subscription) instead of the paid API: the USD monthly cap becomes a
-- monthly run cap (runs that used Claude this calendar month, UTC); 0 = Claude off. The old
-- "claude_monthly_cap_usd" column is left in place (no longer in the Prisma schema) so the processes still running
-- the previous release keep working during the deploy; it can be dropped by a later migration.
ALTER TABLE "enrichment_settings" ADD COLUMN "claude_monthly_run_cap" INTEGER NOT NULL DEFAULT 0;
