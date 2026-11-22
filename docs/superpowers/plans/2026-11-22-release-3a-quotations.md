# Release 3A — Quotations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prototype's Quotations list and editor: priced quotations in USD/CAD/INR with GST, revisions frozen on send, a server-drawn PDF emailed from the sender's mailbox, and lead/company effects on accept.

**Architecture:** Tables `quotations`, `quotation_lines` (working copy), `quotation_revisions` (frozen snapshots), single-row `company_settings`; shared `quoteTotals` + money formatting; `routes/quotations.ts`; PDF built in the API from a snapshot; sending reuses the 2B-1 outgoing job with an attachment and applies the quotation effects when the send succeeds; web `pages/quotations/*`, Settings → Company details.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, Microsoft Graph sendMail (attachments), one PDF library (no browser), React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-release-3a-quotations-design.md`

## Global Constraints

- Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`); `TZ=Europe/London npm test`; e2e after `npm run build`; Prisma drift check empty; `npm run i18n:check` clean (en/es/fr).
- Currencies exactly `USD | CAD | INR`; default by company country: India → INR, Canada → CAD, else USD; tax defaults INR 18, USD 0, CAD 0; one "GST" line.
- Issuer (seed): DAIT Partners LLP · D-303, Sagar Sadan, IP Extension, Delhi 110092, India · info@daitpartners.com; GSTIN optional, printed only on INR quotations when set.
- Number `Q-YYYY-NNN`, sequential per calendar year of the quotation date, unique.
- Locked statuses: Accepted, Rejected, Expired (no edits, no send; Duplicate allowed). Reject never changes the lead's status.
- Effects of Send happen only when the send job succeeds; mail stays the sender's private mail.
- One new dependency only: an established PDF library, version published ≥ 2 weeks ago, pinned exactly; no headless browser.
- Screens match the prototype (`prototype/js/views-work.js` V.quotes / V.quoteEditor); the last task is a screenshot parity check.
- Never push or deploy without the owner saying "deploy".

## Review Focus

1. Send fails (mailbox revoked) → quotation still Draft/previous status, no frozen revision, lead unchanged, owner notified; Send again works.
2. Edit after send then Accept without re-sending → confirm, unsent edits discarded, accepted total = last sent revision's total.
3. Two users edit the same quotation → second save 409 stale; two quotations created at the same moment → distinct numbers.
4. INR quotation with GSTIN set → GSTIN on the PDF; USD → no GSTIN line; INR amounts grouped 12,34,567.00.
5. A Sales Representative cannot see or open a quotation on a lead they cannot see (404), nor list it.

---

### Task 1: Data, totals, numbering, settings

**Files:** `prisma/schema.prisma` + migration `prisma/migrations/20261202100000_quotations/` (tables + `company_settings` seed row), `packages/shared/src/quotations.ts` (new, exported), `packages/shared/src/schemas/quotation.ts` (new), tests `packages/shared/test/quotations.test.ts`, `apps/api/test/quotationNumber.test.ts`, `apps/api/src/quotations/number.ts` (new).

**Interfaces — Produces:**
- `QUOTE_CURRENCIES = ['USD','CAD','INR'] as const`; `QUOTE_STATUSES = ['Draft','Sent','Negotiating','Accepted','Rejected','Expired'] as const`; `QUOTE_LOCKED = ['Accepted','Rejected','Expired']`.
- `defaultCurrency(country: string | null): QuoteCurrency`; `defaultTaxRate(currency, settings?)`.
- `quoteTotals({ lines: {qty, price, discount}[], overallDiscount, taxRate }): { sub, disc, afterLines, overall, net, tax, total }` (prototype formula; round each line and the result to 2 dp).
- `formatMoney(amount: number, currency: QuoteCurrency): string` → `USD 12,000.00` / `INR 12,34,567.00`.
- Models: `Quotation` (id, number unique, companyId, contactId?, leadId?, ownerId, quotationDate @db.Date, validUntil @db.Date?, currency VarChar(3), subject VarChar(300), taxRate Decimal(5,2), overallDiscount Decimal(5,2), notes Text, status, revision Int default 1, editingNewRevision Bool, sendingMessageId Int? (the queued email while "Sending…"), projectId Int?, history Json (array of `{at, text}`), timestamps), `QuotationLine` (quotationId, sortOrder, item VarChar(300), description Text?, qty Decimal(12,2), unit VarChar(30), unitPrice Decimal(14,2), discount Decimal(5,2)), `QuotationRevision` (quotationId, revisionNo, sentAt, sentTo, subtotal/discountTotal/taxTotal/grandTotal Decimal(14,2), note, snapshot Json; `@@unique([quotationId, revisionNo])`), `CompanySettings` (id = 1, legalName, addressLines Json, email, gstin?, taxInr/taxUsd/taxCad Decimal(5,2), defaultNotes Text).
- `nextQuotationNumber(tx, quotationDate: Date): Promise<string>` (row lock / advisory lock per year, `Q-YYYY-NNN`, NNN zero-padded to 3, grows past 999).
- Zod: `QuotationCreate { companyId, leadId?, contactId? }`, `QuotationUpdate { …editable header fields, lines?: LineInput[], updatedAt }`, `CompanySettingsUpdate`.

- [ ] **Step 1: Failing tests** — `quoteTotals` on the prototype's example (2 lines with discounts, overall 5%, tax 18%) to the cent; zero lines; `formatMoney` USD/CAD/INR incl. 1234567 → `INR 12,34,567.00`; `defaultCurrency('India')`, `('Canada')`, `('United States')`, `(null)`; numbering: first of 2026 `Q-2026-001`, next `Q-2026-002`, a 2027-dated one `Q-2027-001`, 10 concurrent creates → 10 distinct numbers.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; shared + api suites; drift empty.
- [ ] **Step 5: Commit** `feat(quotations): data model, totals, numbering and company settings`

### Task 2: Quotations API (no sending)

**Files:** `apps/api/src/routes/quotations.ts` (new, registered), `apps/api/src/quotations/visibility.ts`, `apps/api/src/quotations/service.ts`, `apps/api/src/routes/settings.ts` (Company details GET/PUT, `manage_users` / Administrator), `apps/api/src/jobs` expiry scheduler (`scheduleQuotationExpiry` in the worker's minute schedule, runs the daily check), tests `apps/api/test/quotations.test.ts`, `apps/api/test/companySettings.test.ts`.

**Interfaces — Produces:** `GET /api/quotations?tab=all|draft|sent|accepted|closed&s=` → `{ items, tiles: { openCount, openSums: {currency,amount}[], acceptedCount, acceptedSums, expiringSoon: {id,number,validUntil}[], winRate, sentCount } }`; `POST /api/quotations` (defaults per spec) → detail; `GET /api/quotations/:id` → detail `{ …header, lines, totals, displayTotals (last sent revision while editingNewRevision, else working), revisions[], history[], locked, sending, canEdit }`; `PATCH /api/quotations/:id` (409 stale; locked → 409 `locked`; on Sent/Negotiating any PDF-visible change opens revision n+1 once, history "Revision n opened for editing"); `POST /:id/negotiate` (Sent→Negotiating), `/:id/accept`, `/:id/reject` (from Draft/Sent/Negotiating; `{ discardUnsent?: boolean }` required true when editingNewRevision, else 409 `unsent_changes`; discard restores lines/header from the last snapshot); `POST /:id/duplicate` → new Draft. `GET/PUT /api/settings/company`.
Effects: create → lead activity `quote` "Quotation drafted · Q-…" (subject as body); accept → `applyStatusChange` to Won (existing rules), company `isClient = true`, notify owner "Quotation accepted · Q-… · <formatMoney total>" body "Convert to project?" link `/quotations/:id`, activity "Quotation accepted · Q-…"; reject → activity "Quotation rejected · Q-…", lead status untouched; expiry → Sent/Negotiating with validUntil < today (owner tz) → Expired, history, notify owner. Visibility: lead visible (leadWhere) or, without lead, company visible (companyWhere). Edit rights: owner, lead assignee, or `view_all_leads`.

- [ ] **Step 1: Failing tests** — create defaults (INR for an India company, tax 18, +30 days, one line, notes from settings, contact = lead's); list tabs/tiles/search; PATCH on Sent opens revision 2 once; PATCH on Accepted → 409 locked; accept from Draft → lead Won + client flag + notification; reject on a Won lead leaves Won; accept with unsent edits without flag → 409, with flag → lines restored to rev snapshot; duplicate of an Accepted → new Draft; rep cannot see a quotation on a hidden lead (404, not listed); expiry job; settings PUT by non-admin → 403.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; api suite.
- [ ] **Step 5: Commit** `feat(quotations): API — list, create, edit with revisions, accept, reject, duplicate, expiry, company details`

### Task 3: PDF

**Files:** `apps/api/package.json` (+ the PDF library, exact version), `apps/api/src/quotations/pdf.ts` (new), `apps/api/assets/` (logo copied from `prototype/assets/logo-full.png` if usable), route `GET /api/quotations/:id/pdf?rev=n` in `routes/quotations.ts`, i18n label table for PDF (en/es/fr), tests `apps/api/test/quotationPdf.test.ts`.

**Interfaces — Produces:** `renderQuotationPdf(snapshot: QuotationSnapshot, settings: CompanySettings, lang: 'en'|'es'|'fr'): Promise<Buffer>`; `QuotationSnapshot` = header + lines + totals + company/contact display fields (also stored in revisions). The route renders the working copy (Draft / editing) or `rev` when given; `Content-Type: application/pdf`, `Content-Disposition: inline; filename="Q-2026-001-rev1.pdf"`.

- [ ] **Step 1: Failing tests** — buffer starts with `%PDF`; text extraction (the library's own, or a simple search of the uncompressed content if supported) contains issuer name, "D-303, Sagar Sadan", number, each line item, `GST 18%`, `INR 12,34,567.00`; GSTIN present only for INR with gstin set; Spanish labels for an es owner; 40 lines → more than one page with page numbers.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement (layout per prototype preview).  **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(quotations): PDF drawn on the server`

### Task 4: Send by email

**Files:** `apps/api/src/graph/client.ts` (`MailMessage.attachments?: { name, contentType, contentBase64 }[]`), `apps/api/src/mail/outgoing.ts` (accept attachments + `quotationId`), `apps/api/src/jobs/handlers/sendUserEmail.ts` (on success call `onQuotationSent`, on final failure `onQuotationSendFailed`), `apps/api/src/quotations/send.ts` (new), route `POST /api/quotations/:id/send { body?: string }`, tests `apps/api/test/quotationSend.test.ts`.

**Interfaces — Produces:** `POST /:id/send` → 202 detail with `sending: true` (409 `no_contact_email`, `no_mailbox`, `locked`, `sending`); snapshot built and PDF rendered at queue time, stored on the queued job/message so the email carries exactly what was previewed; subject `Quotation <number> · <subject>`; default body (localised) editable. `onQuotationSent(tx, messageId)`: if editingNewRevision or never sent → insert revision (n) from the queued snapshot, else (re-send, no edits) history "Sent again · rev n" only; status Sent (stays Negotiating); clear editingNewRevision and sendingMessageId; lead → Proposal Sent when its status is earlier (New, Not Contacted, Contacted, Qualified, Interested — use the pipeline order in shared); activity `quote` "Quotation sent · Q-… rev n" body `<formatMoney total>`; history "Sent · rev n · emailed as PDF to <contact>". `onQuotationSendFailed`: clear sendingMessageId, history "Send failed", notify owner; nothing else changes.

- [ ] **Step 1: Failing tests** — send queues a message with one PDF attachment (fake Graph receives attachments); before the job runs: status unchanged, `sending: true`, PATCH → 409 `sending`; job success → revision 1 row, status Sent, lead Proposal Sent, activity; edit + resend → revision 2; resend without edits → still one revision row per number, history line; job final failure → nothing changed except history + notification; contact without email → 409; mailbox not connected → 409.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; api suite.
- [ ] **Step 5: Commit** `feat(quotations): send by email with the PDF attached; effects when the send succeeds`

### Task 5: Quotations list, entry points, sidebar, dashboard (web)

**Files:** `apps/web/src/api/quotations.ts`, `apps/web/src/pages/quotations/QuotationsPage.tsx`, `apps/web/src/pages/quotations/NewQuotationModal.tsx`, `apps/web/src/router.tsx` (`/quotations`, `/quotations/:id`), `apps/web/src/components/Sidebar.tsx` (Quotations after Calendar, icon `quote`), `apps/web/src/pages/companies/CompanyProfile.tsx` ("New quotation" → creates and opens; Quotations list/tab where the prototype has it), `apps/web/src/pages/Dashboard.tsx` ("Quotes awaiting response" tile as prototype; drop its "release 3" note), locales; tests `apps/web/test/quotations.test.tsx`, e2e `apps/web/e2e/quotations.spec.ts` (list part).

- [ ] **Step 1: Failing tests** — list renders prototype tiles (per-currency sums), tabs with counts, columns in prototype order, search; New quotation dialog (company picker, optional lead) creates and navigates; company page button creates for that company; sidebar entry; dashboard tile count.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; web unit, i18n:check.
- [ ] **Step 5: Commit** `feat(web): Quotations list, new quotation, sidebar and dashboard tile`

### Task 6: Quotation editor + Company details settings (web)

**Files:** `apps/web/src/pages/quotations/QuotationEditor.tsx`, `apps/web/src/pages/quotations/LinesTable.tsx`, `apps/web/src/pages/quotations/SendQuotationModal.tsx`, `apps/web/src/pages/quotations/PdfPreviewModal.tsx`, `apps/web/src/pages/settings/CompanyDetails.tsx` (+ Settings tab, Administrators), locales; tests `apps/web/test/quotationEditor.test.tsx`, e2e `apps/web/e2e/quotations.spec.ts` (editor: create → lines → send (fake Graph) → revision → accept → lead Won).

Behaviour = prototype V.quoteEditor: topbar `Q-… · <company> [status] [Revision n · editing]`, subtitle Lead · Contact · Company · Owner, buttons Preview PDF / Duplicate / Send by email (hidden when locked); Quotation details grid (number read-only, date, valid until, currency, company read-only, contact select, lead, subject); Products & services table (item + description, qty, unit, unit price, discount %, line total, delete; + Add line); Notes & terms; totals block (Subtotal, Line discounts, Overall discount % input, GST % input, Total); autosave with debounce and 409 handling like other forms; currency change resets GST to default; first edit on Sent shows toast "Revision n opened · previous version kept"; side cards Status steps (Draft, Sent, Negotiating, Accepted + Rejected/Expired), buttons Mark negotiating / Mark accepted / Mark rejected (confirm when unsent changes), Convert to project disabled "Available in release 3B" when Accepted; Revisions; History; On accept text. "Sending…" state disables editing. Preview PDF shows `/api/quotations/:id/pdf` in a dialog (iframe/object) with Download; Send dialog: To read-only, editable message, text per prototype.

- [ ] **Step 1: Failing tests** — totals update live; currency → GST reset; locked status hides send/edit; accept with unsent changes asks to confirm and sends `discardUnsent: true`; send dialog requires contact email (prototype toast); sending state; Company details form saves (admin) and is hidden for reps.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; web unit, i18n:check, build, `quotations.spec.ts`.
- [ ] **Step 5: Commit** `feat(web): quotation editor, PDF preview, send dialog and Company details`

### Task 7: Visual parity check + pending list + full verification

**Files:** `apps/web/e2e/parity/quotations.spec.ts`, `docs/PENDING.md`.

- [ ] **Step 1:** Capture app vs prototype at 1440×900 into `/Users/mac/Documents/DAIT-CRM/parity-screenshots-3a-quotations/`: list (each tab), editor Draft / Sent / Revision editing / Accepted, PDF preview (compare against the prototype's preview dialog), send dialog, New quotation from company page, dashboard tile, Settings → Company details (no prototype — check it uses the app's settings style). Compare each pair; fix every GAP; re-capture; write `parity-report.md`.
- [ ] **Step 2:** `docs/PENDING.md`: 3A section (status, owner decisions, builder's calls, follow-ups: GSTIN to fill in, CGST/SGST later if needed, Convert to project in 3B).
- [ ] **Step 3:** `TZ=Europe/London npm test`, build, full e2e, i18n:check, drift — all green; counts noted.
- [ ] **Step 4: Commit** `docs: release 3A quotations done` (+ parity fixes as their own commits).
