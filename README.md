# DAIT Partners CRM

Full-stack CRM for DAIT Partners, built as an npm-workspaces monorepo (Node >= 24):

| Path | Purpose |
|---|---|
| `packages/shared` | Shared TypeScript (roles, `safeUrl`), compiled to `dist/` and imported as `@dait-crm/shared` |
| `apps/api` | Fastify 5 API (routes under `/api`); Prisma + PostgreSQL arrive in a later task |
| `apps/worker` | Background worker (idle placeholder for now) |
| `apps/web` | React + Vite front end |
| `prototype/` | The original HTML/JS prototype, kept for reference (see below) |

## Run

    cp .env.example .env
    npm install
    npm test            # builds packages/shared first, then runs all tests
    npm run typecheck
    npm run build

Development: `npm run dev -w apps/api` (port 3090) and `npm run dev -w apps/web` (Vite proxies `/api` to the API).
To serve the built web app from the API: `WEB_DIST=apps/web/dist node apps/api/dist/server.js`.

Deployment (test and live servers, GitHub Actions, backups): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Modules

- **Settings** (release 1A): my settings, users, lookups, allocation rules, system mailbox.
- **Companies** (release 1B): list with search, filters, sorting and bulk status; live duplicate check; profile with Overview, Contacts and Locations tabs (release 1C adds the Leads & Prospects and Activities tabs, and the Client flag, editable by administrators and managers). Sales representatives see companies they created or that have a lead assigned to them.
- **Contacts** (release 1B): every visible contact across companies, with search, type filter and an Add contact form that picks the company. Release 1C adds deactivate / reactivate (inactive contacts are left out of pickers) and moving a contact to another company.
- **Leads** (release 1C): inbound leads and researched prospects in one list with tiles, views, filters and bulk assign/archive; live duplicate check that links to an existing company; lead page with status steps, log call, follow-up, transfer, claim, close (Won marks the company a client, Lost needs a reason) and a timeline; CSV import with a review step for possible company matches. Sales representatives see their own and unassigned leads.
- **Tasks** (release 1C): follow-up tasks kept in step with each lead's next follow-up, plus your own tasks; Today, Overdue, Upcoming and Done tabs, tick to complete, snooze to tomorrow.
- **Notifications** (release 1C): new assignments and transferred leads, with an unread count on the bell and Mark all read.

Owner walkthroughs: [docs/PHASE-1A-CHECKLIST.md](docs/PHASE-1A-CHECKLIST.md), [docs/RELEASE-1B-CHECKLIST.md](docs/RELEASE-1B-CHECKLIST.md), [docs/RELEASE-1C-CHECKLIST.md](docs/RELEASE-1C-CHECKLIST.md).

## Prototype (reference)

A working single-page prototype of the enhanced CRM. No build step, no server: open `prototype/index.html` in a browser
(or serve the folder with any static server). All data lives in `localStorage`; use **Settings → Reset sample data**
to start over.

## Building the double-click files

`dait-crm.html` and `contact-form.html` are generated: they inline the CSS, scripts and logos so they open without a server.
After changing anything in `index.html`, `css/`, `js/`, `assets/` or `public/`, run:

    python3 prototype/build.py

Never edit the two generated files by hand. The Montserrat font still loads from Google Fonts, so offline the pages fall back to
a system font; everything else works offline.

## What is here (paths relative to `prototype/`)

| Path | Purpose |
|---|---|
| `index.html` | App shell: sidebar + `#view`. Hash routing (`#/leads`, `#/companies/CO-0318/ai`, …). |
| `css/app.css` | Brand theme tokens (purple/orange palette, Montserrat) and all components. |
| `js/data.js` | Seed data shaped like the proposed tables (companies, contacts, leads, lead_activities, lead_assignments, tasks, contact_enquiries, enrichment_history, source_records, emails, calendar_events, quotations…). |
| `js/store.js` | **Mock data layer.** Stands in for the Node.js API. Every business rule lives here, not in the views. |
| `js/ui.js` | Template helpers, badges, timeline, modal, toast, and the searchable dropdown (`enhanceSelects`: any select with 8+ options becomes a type-to-filter combobox). |
| `js/views-leads.js` | Shared page helpers, CSV import and the create lead/prospect form (live duplicate detection). |
| `js/views-leads2.js` | **Leads** (list + lead page), person first. List: tiles, tabs, filters, then a paged, sortable table (25/50/100 rows; built for 100,000+ leads: filter, sort, render one page). Lead page: collapsible profile box (person 70% with lead facts, experience 30%), collapsible Email / Call / Meeting / Research composer, and a Follow-up / Emails / Calls card. Built on top of `views-lead-detail.js`, which supplies the composer, follow-up controls and timeline. Profile data is entered by the team; nothing is fetched from LinkedIn. |
| `js/views-calendar.js` | **Calendar** built around follow-ups: mini month and overdue list on the left; Day / Week / Month on the right; follow-up tasks (optionally timed) shown with calls and meetings; click an empty day to add one, click an item to open its lead; Mine / Everyone switch. **Notifications** page: the acting user's notifications grouped by day, All / Unread tabs, type filters, mark all as read, and a live "needs attention" strip (overdue and due-today follow-ups, unread email, live mailer runs). |
| `js/views-mailer.js` | **Mailer**: the Send via mailer wizard opened from the Leads page (template → Cc/Bcc → timing → review) and the Mailer page (campaigns, live progress, pause / resume / cancel, per-recipient audit). The rules are in `js/store.js` under "mailer". |
| `js/views-companies.js` | Companies list, tabbed profile (Overview A–G, Contacts, Locations, Leads & Prospects, Activities, AI Intelligence, Research Sources). |
| `js/views-enquiries.js` | Contact enquiries: immutable record, processing trace, manual review queue. |
| `js/views-work.js` | Dashboard, Tasks, Email, Calendar, Quotations (list + editor with revisions). |
| `js/i18n.js` | Language layer: English (default), Spanish, French. Exact-phrase dictionary applied after each render; per-user preference. |
| `js/oft.js` | Reads Outlook `.oft` / `.msg` files in the browser (OLE compound file → subject, body, HTML). |
| `js/views-projects.js` | Projects (many per client, each from a lead), create/edit modal, Projects page, and the Client → Lead → Project email composer with stakeholders pre-filled. |
| `js/views-settings.js` | Settings → Preferences (language), Email templates (write or upload .oft), Email & calendar connections: connect Microsoft 365 (simulated sign-in + consent), Google or IMAP; sync, options, disconnect. |
| `js/app.js` | Router, sidebar, Settings and Reports pages. |
| `build.py` | Builds `dait-crm.html` and `contact-form.html` from the source (see above). |
| `public/contact.html` | The six-field public Contact Us form. Writes to the same mock database so you can watch an enquiry become company + contact + lead. |

## Rules the mock data layer enforces (see `js/store.js`)

- **Duplicate detection** — company: exact domain → exact legal name → normalised name + country → manual review.
  Contact: exact email → normalised phone → name + company. Never auto-merged on similar names alone.
- **Immutable enquiries** — `submitEnquiry()` stores the original submission first; later edits to company/contact never touch it.
- **Enquiry workflow** — validate → store → match/create company → match/create contact → create lead
  (Type = Lead, Source = Website Contact Form, Status = New, enrichment = Pending) → allocation rule → notify owner → follow-up task.
  Ambiguous company matches are held in **Needs review**; no lead is created until a user decides.
- **Lead allocation & transfer** — allocation rules by country (with round-robin fallback); transfers require a note,
  write `lead_assignments`, move open tasks, and notify the receiver.
- **Follow-up → task** — setting a follow-up date creates or updates a task in the owner's list; overdue/today views derive from it.
- **AI enrichment** — `runEnrichment()` only proposes values for fields that are not verified; accepting a suggestion marks the
  field AI-sourced; verified fields are locked. Unknown values stay `null`. Engine and sources are configurable.
- **Won from any screen** — status control, call log, close dialog or accepted quotation all go through one rule: lead Won,
  company flagged Client, one activity with the previous status. The Won dialog offers "Mark Won and create project".
- **Closing a lead** (Won / Lost / Not Relevant) clears the follow-up date and closes its open tasks; clearing a follow-up date
  removes its task. Unassigning writes assignment history.
- **Links** — every URL from data goes through `Store.safeUrl` / `UI.href`; only http(s), mailto and tel become links.
- **Saved data from older builds** is upgraded on load (`migrate()` fills any missing collection or config list from the seed).
- **Mailer** — only for users with a connected mailbox. A lead is skipped when it has no or an invalid address, is marked do not email, its contact unsubscribed, it is closed or archived, or its address already appears in the same run. The same checks run again at send time, and a lead that replied after the campaign was created is skipped. Lawful basis is required. Emails go one at a time at the chosen spacing (optionally working hours only), are filed on the lead like any other email, and move New / Not Contacted leads to Contacted. Pause, resume, start now and cancel remaining. The template text is saved with the campaign. Prototype only: one minute of spacing runs as one second, and `campaignTick()` (called once a second by `js/app.js`) stands in for the background worker.
- **Quotations** — quantities and prices ≥ 0, discounts and tax 0–100 %; cannot send without a contact email; Accepted /
  Rejected / Expired are read-only; a quotation converts to a project once. Live totals (line discounts, overall discount, tax); sending freezes a revision and logs an email + activity;
  editing after sending opens a new revision; Accepted → lead Won + company flagged Client; Convert → project record.

## Switching users

The selector under the avatar switches the acting user (Sales Rep, Manager, Data Research, Administrator) so you can see
assignment, transfer notifications and task lists from each side.
