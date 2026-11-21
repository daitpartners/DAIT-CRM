# Reports (release 1E) — short design

Owner, 22 Nov 2026: "Do not do anything from your side, go to the final design and take inspiration from there."
So 1E is the prototype's Reports view only (`prototype/js/app.js` `reports()`, reference screenshot
`apps/web/e2e/parity/out/reports-proto.png`); the clean-up list I proposed is dropped.

- **Topbar:** title "Reports", sub "Existing dashboard and reporting stay as they are; these are the additions for the new modules".
- **Leads by source** (card, left): one row per lead source of all non-archived leads (the prototype counts every lead,
  not the viewer's), largest first; label left, count right (bold), a bar under it sized to the largest count.
  Source shown with its lookup label in the user's language.
- **Enquiry conversion** (card, right): Enquiries received, Spam blocked, Leads created, Awaiting manual review,
  Matched existing companies. There is no enquiry table until 1D (parked), so each is 0, which is what the
  prototype's formulas give with no enquiries.
- Route `/reports` replaces the "Available in release 1E" placeholder. API: `GET /api/reports` → `{ bySource:
  [{ source, count }], enquiries: { received, spamBlocked, leadsCreated, awaitingReview, matchedExisting } }`.

Approaches: (1) copy the prototype — chosen by the owner; (2) my proposal with role-scoped counts, a "—"/
"Available once the contact form ships" note and a polish pass — rejected ("do not do anything from your side").
