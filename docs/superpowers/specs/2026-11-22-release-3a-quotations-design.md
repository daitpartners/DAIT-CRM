# Release 3A — Quotations (design)

Owner, 22 Nov 2026: "Start release 3" (3A after 3C). Currencies "USD, CAD and INR"; tax "Yes" to: currency per quotation
defaulted from the client's country (India → INR, Canada → CAD, else USD), GST 18% on INR and 0% on USD/CAD as one
"GST" line, totals per currency with no conversion. Issuer: **DAIT Partners LLP, D-303, Sagar Sadan, IP Extension, Delhi
110092, India, info@daitpartners.com** — one entity for every currency. PDF approach "A" (server draws it with a small
library). Standing rules: screens match `prototype/index.html` (`views-work.js` V.quotes / V.quoteEditor, quotation
rules in `store.js`, "New quotation" on the company page `views-companies.js`), checked by side-by-side screenshots
before "done"; build only what the prototype shows; mail is private to its owner. Dev-plan fix carried in: rejecting a
quotation never turns a lead Lost; Accepted, Rejected and Expired quotations are locked. Data shape: `docs/data-model.md`
Module 6.

## Intent

A salesperson prepares a priced quotation for a lead in minutes, sends it as a PDF from their own mailbox, keeps every
sent version, and the CRM moves the lead along (Proposal Sent, Won) as the client answers.

## Goals / non-goals / anti-goals

- Goals: Quotations list (tiles, tabs, search), quotation editor (details, lines, totals, notes, status, revisions,
  history, on-accept card), Preview PDF, Download PDF, Send by email with the PDF attached, Duplicate, Negotiating /
  Accept / Reject, automatic Expired, revisions frozen on send, lead/company effects, Settings → Company details,
  sidebar Quotations entry, dashboard "Quotes awaiting response" tile, timeline entries.
- Non-goals: Convert to project (release 3B — the button shows disabled "Available in release 3B"); a price list /
  product catalogue (not in the prototype UI); invoices; e-signature or a client acceptance page; exchange rates;
  CGST/SGST split; reports changes (3B/later).
- Anti-goals: a sent revision changing after it was sent; a rejected quotation turning a Won (or any) lead Lost; an
  accepted / rejected / expired quotation edited; a quotation emailed to anyone but the chosen contact; the email or PDF
  readable by other users through the Email screen (the sent email stays the sender's private mail, as 2B-1).

## Approaches (PDF)

1. **Chosen (owner "A"):** the API draws the PDF with one small, established PDF library (no browser), laid out like the
   prototype's preview; the same bytes serve Preview, Download and the email attachment.
2. Headless Chrome printing the preview page — rejected: ~300 MB and heavy memory on the shared server.
3. Browser "Print → Save as PDF" only — rejected: Send by email could not attach the PDF.

## Decided

**Data (data-model Module 6, adjusted).** `quotations` (number `Q-YYYY-NNN` unique, sequential per calendar year of the
quotation date; company, contact (nullable), lead (nullable), owner, quotation date, valid until, currency
`USD|CAD|INR`, subject, tax rate %, overall discount %, notes/terms, status, current revision, editing-new-revision flag,
project id nullable), `quotation_lines` (belong to the quotation's current working copy: sort order, item, description,
qty, unit, unit price, discount %), `quotation_revisions` (revision no, sent at, sent to, subtotal, discount total, tax
total, grand total, note, frozen snapshot JSON of header + lines; PDF regenerated from the snapshot on demand — no file
storage). Money as decimals; totals computed by one shared function (prototype `quoteTotals`): line total = qty × price
× (1 − discount%); subtotal = Σ qty × price; line discounts; overall discount % on the discounted sum; GST % on the
result; total. Rounded to 2 decimals per line and at the end.

**Defaults on create.** From a lead ("New quotation" on the lead page, if the prototype lead page shows it; otherwise from
the list with a lead picker), a company ("New quotation" on the company profile, prototype) or the list. Contact = the
lead's contact, else the company's primary. Currency from the company's country (India → INR, Canada → CAD, else USD).
Tax: INR 18, USD 0, CAD 0 — defaults kept in Settings → Company details. Date today (owner's time zone), valid until +30
days, one line "Consulting services · 1 · project · 0", notes default from Settings (prototype text with "VAT" → "GST").
Subject "Advisory services for <company>" (prototype). Timeline entry on the lead "Quotation drafted · Q-…".

**Statuses and rules (prototype store.js, with the plan's fixes).**
- Draft → Send → Sent; Sent → Negotiating (button "Mark negotiating"; no way back, as the prototype); Draft, Sent or
  Negotiating → Accepted or Rejected (the prototype shows both buttons on every unlocked quotation — a client may accept
  verbally);
  Sent/Negotiating past valid-until → Expired (worker, once a day, the day after valid-until in the owner's time zone;
  lead untouched; owner notified).
- Locked: Accepted, Rejected, Expired — no edits, no send; Duplicate still allowed (creates a new Draft).
- Editing lines or overall discount of a Sent/Negotiating quotation opens the next revision (toast "Revision n opened ·
  previous version kept"); sending freezes it into `quotation_revisions`.
- Send by email: needs a contact with an email address and the user's connected mailbox; emails the PDF (file name
  `<number>-rev<n>.pdf`) from the sender's own mailbox through the existing outgoing path (2B-1), subject
  "Quotation <number> · <subject>", a short default body the user can edit in the confirm dialog (prototype dialog shows
  To read-only); records the email as the sender's private mail linked to the lead; freezes the revision; status Sent
  (stays Negotiating if it was); lead → Proposal Sent when earlier in the pipeline (prototype); timeline "Quotation sent ·
  <number> rev <n>" with the total.
- Accept: lead → Won (existing status rules), company Client flag, owner notified "Quotation accepted · … · Convert to
  project?" (link works in 3B). Reject: lead status unchanged. Both write a timeline entry and history.
- Optimistic concurrency like the rest of the app (409 stale).

**Who may do what.** Visible to users who can see its lead (lead visibility) or, without a lead, its company (company
visibility). Create/edit/send/status: the owner, the lead's assignee, or roles with `view_all_leads`. Transfer of owner:
not in the prototype — not built.

**Screens (prototype).** Quotations list exactly as V.quotes (tiles: Open value (sent + negotiating) summed per currency
"USD 12,000 · INR 4,50,000"-style with the app's number format, Accepted, Expiring within 7 days, Win rate; tabs; columns
Quotation no., Company, Contact, Lead, Date, Valid until, Total, Rev., Status, Owner; search number/company/lead/subject).
Editor exactly as V.quoteEditor (topbar number · company + status + revision badges, Preview PDF, Duplicate, Send by
email; Quotation details card; Products & services table with live totals; Notes & terms; side Status steps, Revisions,
History, On accept). Preview PDF opens the PDF in a dialog / new tab; Download from the same.
Company profile "New quotation" button and Quotations tab/list where the prototype has them; lead page placement as the
prototype shows. Sidebar "Quotations" after Calendar. Dashboard tile "Quotes awaiting response" (count of own
Sent/Negotiating) as the prototype.

**PDF content (prototype preview).** Logo, issuer block (Settings → Company details: DAIT Partners LLP, address, email;
GSTIN line only when set and the currency is INR), "Quotation <number>", date · valid until · revision, To (company legal
name, contact, address if known), lines table, totals with "GST <rate>%", notes & terms, page numbers. Amounts with
currency code and two decimals; INR grouped Indian-style (12,34,567.00), USD/CAD western-style.

**Settings → Company details (new, Administrators).** Legal name, address lines, email, GSTIN (optional), default tax per
currency (INR 18, USD 0, CAD 0), default notes & terms. Seeded with the owner's values above.

**Languages.** UI in en / es / fr. The PDF text in the quotation owner's language (en/es/fr) — labels only; user-entered
text as typed.

**Builder's calls (from the builder check, marked as such).**
- *When "sent" counts:* the revision is frozen, status set and lead moved only when Microsoft confirms the send (the
  existing send job succeeds). While queued the quotation shows "Sending…" and is not editable; if the send finally
  fails, nothing changes on the quotation or lead, the owner is notified and can send again.
- *What opens a new revision:* after a send, any edit to something printed on the PDF (lines, discounts, currency, tax,
  dates, contact, subject, notes) opens revision n+1. Sending again with no edits re-sends revision n (a history line and
  a sent-to entry, no new revision), so `(quotation, revision no)` is unique.
- *Which figures count:* list totals, tiles, the dashboard, the company page and the accept notification use the last
  sent revision while revision n+1 is unsent (a Draft uses its working copy). Accepting or rejecting while revision n+1
  is unsent discards that unsent edit after a confirm ("Revision n+1 has unsent changes — they will be discarded"); the
  accepted amount is what the client received.
- *Currency change:* changing the currency resets the tax rate to that currency's default (INR 18, USD 0, CAD 0); it
  stays editable.
- *New quotation from the list:* a small dialog to pick a company (and optionally its lead), then the editor opens.
- *Accept without a lead:* the company still gets the Client flag.

## Left to the builder

Which PDF library (established, pinned ≥ 2 weeks old, no browser); API shapes; file layout; number sequence locking;
the expiry job's schedule; how the PDF preview is shown (inline viewer vs new tab) as long as it looks like the
prototype's dialog; tests. Before calling it done: the screenshot parity check (list, editor in each status, PDF preview,
send dialog, company/lead entry points, Settings → Company details, dashboard tile) against the prototype, differences
fixed or listed for the owner.
