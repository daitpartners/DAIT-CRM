# Delete leads (with their company) (design)

Owner, 25 Nov 2026: "do we have provision to delete the leads (along with company)?" → proposed design → "yes, i think
so, there are many leads, while i am doing deep research, their data and email is not correct, no point keeping that
leads with us in the CRM. please build."

## Decided
1. **Who:** Administrators only (new right `delete_leads`, Administrator role only).
2. **Where:** lead page (Delete lead…, in the existing actions menu / Edit profile actions row) and the Leads list bulk
   bar (Delete… for ticked leads, max 500 at once). Archived leads can be deleted too.
3. **Preview first** (same pattern as import Undo): server returns, for the chosen leads, what will be removed and what
   will be kept with reasons; the dialog lists it; the Administrator types `delete` to confirm. Re-planned under locks on
   confirm (never removes more than is safe; may remove less if something changed).
4. **Removed with a lead:** the lead, its tasks/follow-ups, notes, timeline/activity entries, call/meeting records that
   belong only to it, its AI research suggestions for the lead, notifications pointing at it, mailer recipient links
   (campaign history kept with the lead reference cleared), import row links (cleared).
5. **Company and contacts:** the lead's company is removed too — with its contacts, locations, research runs/sources,
   suggestions — when after this deletion it has NO other leads (archived included) and NO projects and NO quotations;
   otherwise kept (reason shown). A contact used by another lead is kept.
6. **Emails never block and are never deleted:** email_messages linked to the lead / its contacts / company are unlinked
   (lead/contact/company set to null) and stay in their owner's mailbox; mail remains private to its owner. Calendar
   events linked to the lead are unlinked, not deleted.
7. **Blocked (kept, "archive instead" offered):** a lead with any quotation that was sent/accepted (Draft-only
   quotations are deleted with the lead), or with a project.
8. **Audit:** one audit entry per deleted lead/company (who, when, lead number, company name, counts) — no deleted
   content.
9. All in one transaction per batch of leads (or chunks of 100 with clear progress if large); errors roll back that
   chunk. Lock order consistent with import commit/undo (lead → company → contacts) to avoid deadlocks.
10. en/es/fr; only live app styles; Sales Reps / Managers never see the actions; API refuses (403).

## Left to the builder
Exact FK handling per table (read prisma/schema.prisma — set null vs cascade per relation; add a migration only if a
relation needs ON DELETE changes), API shapes (preview + confirm), UI dialog reusing the Undo preview component style,
tests (each kept/removed rule, emails unlinked not deleted and still visible to their owner, quotations/projects block,
shared company kept, permissions, concurrency with an edit, bulk 500), e2e: Administrator deletes a lead with a
company that has no other leads → both gone; Manager sees no action; screenshots of the dialog.
