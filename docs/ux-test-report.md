# DAIT CRM prototype — UX test report

**Tester:** Claude, acting as an independent UX tester · **Date:** 19 Nov 2026 · **Build:** prototype v13 (before fixes) → v14 (after)
**Method:** every screen exercised in a headless Chromium at 1440 px and 390 px; all 69 internal links crawled; every form submitted
empty and with bad values; every destructive action tried; keyboard-only pass on the main lists; consistency check of labels, dates and
wording across modules. Findings are ranked **Critical / High / Medium / Low**. "Fixed in v14" means I corrected it in the same pass
because it was a defect rather than a design choice.

## Verdict

The structure is sound: six modules share one navigation, one visual language and one data model, the action-first lead page is the
right pattern, and the enquiry → company → contact → lead chain is visible everywhere. I would **not approve it for a pilot yet**:
three defects (one crash, two trust problems) had to be fixed, phone layout is not usable, and destructive actions lack confirmation.
With the High items addressed it is ready for a guided pilot with the sales team.

## Critical

| # | Where | Finding | Recommendation | Status |
|---|---|---|---|---|
| C1 | Quotations → "+ New quotation" (header button) | Opening `#/quotes/new` without a lead or company put the app in an infinite re-render loop: ~1,500 quotations and activity rows were created in seconds and the console filled with stack-overflow errors. The lead page then showed 1,400+ timeline entries. | Create the record once, then navigate; never create records inside a render. | **Fixed in v14** |

## High

| # | Where | Finding | Recommendation | Status |
|---|---|---|---|---|
| H1 | Navigation | A modal opened on one screen (compose email, new event, transfer) stayed on top of the next screen after using the sidebar or the browser Back button; the dark overlay blocked everything until Escape. | Close modals on every route change. | **Fixed in v14** |
| H2 | Email → Compose | With no mailbox connected the banner says mail is not sent, but the toast after Send said "Email sent". The user cannot tell whether the client received anything. | Toast now says "Email logged · not sent: connect your mailbox". Also grey out Send until a mailbox exists. | **Fixed in v14** (toast); disable-Send still open |
| H3 | Phone width (390 px) | The sidebar renders as a 633 px tall block above the content on every page, so a phone user scrolls past the full menu each time. Email overflows horizontally (604 px). | Collapse the sidebar into a top bar with a menu button below 900 px; stack the three mail panes. | Open |
| H4 | Settings → Email templates; Calendar → event; Lead → More → Archive | Delete / archive happen instantly with no confirmation and no undo. Disconnect mailbox does confirm, so behaviour is inconsistent. | One confirm pattern for every destructive action, or an "Undo" toast for 8 seconds. | Open |

## Medium

| # | Where | Finding | Recommendation |
|---|---|---|---|
| M1 | Lists (Leads, Companies, Quotations, Enquiries) | No column sorting; no bulk selection (assign, archive, export); "Rows per page" and page numbers are static decoration. | Sortable headers with an arrow; checkbox column with a bulk-action bar; real paging or infinite scroll. |
| M2 | Lead page → "More ▾" | Looks like a dropdown but opens a modal dialog listing actions. | Use a real popover menu anchored to the button. |
| M3 | Lead form | Empty required fields rely on the browser's default validation bubble; no inline highlight, no scroll to the field; style differs by browser. | Inline red border + message under the field, focus the first invalid field. |
| M4 | Quotation editor | Accepts negative quantity/price and >100 % discount; changing currency silently keeps the numbers. | Clamp inputs, inline errors, confirm currency change. |
| M5 | Tasks | Tasks can only be ticked off; no edit, re-date, reassign or snooze. | Click a task to open a small editor; add "Snooze to tomorrow". |
| M6 | Calendar | Day and Month buttons do nothing; no drag to move or resize; hours before 08:00 / after 19:00 are hidden. | Either implement or remove the two buttons; scrollable 00–24 grid with the work-day in view by default. |
| M7 | Email | Message list is mouse-only (no arrow-key navigation); no "Unread" filter; "Awaiting reply" simply shows Sent items. | Arrow keys + Enter in the list; unread toggle; compute awaiting-reply from thread state. |
| M8 | Settings | One long page mixing personal (language, my mailbox, my templates) with admin (dropdowns, allocation rules, roles, hosting). | Two tabs: "My settings" and "Administration"; anchor links on the left. |
| M9 | Keyboard / accessibility | No visible custom focus style; tab strips are links/buttons without `role="tab"` / `aria-selected`; hover-only "verify" buttons on the company profile are invisible to keyboard and touch users. | 2 px purple focus ring on all controls; proper tab roles; show verify buttons on focus-within and always on touch. |

## Low

| # | Where | Finding | Recommendation |
|---|---|---|---|
| L1 | Naming | Sidebar "Enquiries", page title "Contact Enquiries", public page "Contact us". | Pick one word for the internal module ("Enquiries") and keep "Contact us" only on the public site. |
| L2 | Dates | Date pickers show the browser format (mm/dd/yyyy in Chrome) next to tables showing "20 Nov 2026". | Use a styled date picker that renders the CRM format, or show the chosen date beside the input. |
| L3 | Lead page timeline | All events render at once; no "show more". | Show the latest 15 with a "Show earlier" link. |
| L4 | AI Intelligence tab | Accept/Reject rows show the source name only; the evidence is on another tab. | Expand-on-click row showing the source snippet. |
| L5 | Dashboard | Greeting and date are fixed text; KPI tiles have no comparison with the previous period. | Compute greeting/date; add "vs last 7 days" deltas. |
| L6 | Sidebar | "Act as …" user switcher sits in the profile card. Useful for the demo, wrong for production. | Replace with profile menu (profile, language, sign out) in the real build; keep the switcher behind a demo flag. |
| L7 | Public form | Success screen has no "back to site" link; prototype note is visible to visitors. | Add a return link; remove the note in production. |
| L8 | Language | Translation is phrase-based, so a few dynamic strings and sample data stay in English. | Expected for the prototype; the real build keys every string (spec §13). |

## What passed

- All 69 internal links resolve; no dead routes.
- Empty states exist on every list ("No leads match these filters", "No messages for this filter").
- Duplicate detection warns on legal name and on website domain and offers "Use existing company"; contact matching warns on email/phone.
- Enquiry → company → contact → lead chain is traceable from each record, and the original enquiry is read-only.
- Transfer always requires a note and notifies the receiver; follow-up date and tasks stay in sync.
- Searchable dropdowns work with mouse and keyboard, including inside modals; arrows now aligned.
- AI suggestions never overwrite verified fields (locked rows shown).
- Quotation send freezes a revision; accept sets lead Won and company Client; convert creates a project.
- Language switch changes the whole chrome and statuses; .oft upload parses subject and body.
- No horizontal overflow at 390 px on any screen except Email (H3).

## Suggested order of work

1. H3 phone layout and H4 confirmations (one day).
2. M1 sorting/bulk actions and M3/M4 inline validation (one to two days).
3. M8 Settings split, M2 real menu, M9 focus styles (one day).
4. The Low items as polish before the pilot.

## Update — 20 Nov 2026 (pre-hand-over fixes)

- **H4** fixed: deleting a template or calendar event and archiving a lead now ask for confirmation.
- **M4** partly fixed: negative quantities and prices and discounts or tax above 100 % are corrected on entry. A confirmation when the currency changes is still open.
- **M9** partly fixed: visible focus ring on links, buttons and comboboxes; the "verify" buttons show on keyboard focus and on touch screens. Tab roles (`role="tab"`, `aria-selected`) are still open.
- Still open (design work): H3 phone layout, M1–M3, M5–M8 and the Low items.
