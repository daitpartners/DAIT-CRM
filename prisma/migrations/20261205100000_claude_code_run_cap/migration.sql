-- Claude runs through the server's Claude Code (subscription) instead of the paid API: the USD monthly cap becomes a
-- monthly run cap (runs that used Claude this calendar month, UTC). The live USD cap is 0, so nothing is carried over;
-- 0 = Claude off.
ALTER TABLE "enrichment_settings" DROP COLUMN "claude_monthly_cap_usd";
ALTER TABLE "enrichment_settings" ADD COLUMN "claude_monthly_run_cap" INTEGER NOT NULL DEFAULT 0;
