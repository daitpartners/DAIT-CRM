# DAIT Partners CRM — Enhancement & Development Specification (v2)

**Implementation instructions for Claude Code**
**Project:** DAIT Partners Custom CRM · https://crm.daitpartners.com
**Objective:** Enhance the existing Node.js CRM with six integrated modules: Lead Management, Company Management,
Website Contact Us Form, Email, Calendar and Quotation Management, on the existing hosting environment.

Companion material: the design canvas (18 screens) and the HTML/CSS/JS prototype in this repository
(`index.html`, `js/store.js` for the business rules). Where this document and the prototype differ, this document wins.

---

## Build status (handover, 23 Nov 2026)

This specification was written before the build. It is kept as written, with **As built** notes added under each
section. Where a note and the original text disagree, the note describes what runs at crm.daitpartners.com (live
release `08ee5da`). The decisions behind every difference are in the design specs in `docs/superpowers/specs/` (cited
below by file name) and in `docs/PENDING.md`; the tables and columns are in `docs/data-model.md`.

Two decisions change the premise of the whole document:
- **Fresh build, not an enhancement.** There was no existing CRM with data (crm.daitpartners.com served the static
  prototype). The owner decided on 21 Nov 2026: "it's a fresh build, ignore the existing." Every instruction about
  inspecting, preserving or extending existing code, tables, roles or integrations is void
  (`2026-11-21-dait-crm-fresh-build-design.md` §1).
- **Screens match the prototype.** The prototype (`prototype/index.html`, `prototype/js/views-*.js`) is the reference
  for every screen; build only what it shows; each screen is checked side by side against it
  (`2026-11-21-prototype-parity-design.md`). Where the prototype and this document differ on presentation, the
  prototype won.

| § | Section | Status |
|---|---|---|
| 2 | Stack and hosting | Built differently: new Node 24 / Fastify / Prisma / PostgreSQL / React app; Claude Code instead of Ollama |
| 3 | Design and branding | Built |
| 4 | Lead Management | Built (releases 1C, outreach language, leads exact-match) |
| 5 | Company Management | Built (1B; AI fields filled by release 4) |
| 6 | Website Contact Us form | **Not built — release 1D parked by the owner** |
| 7 | Email | Built differently (Microsoft 365 only, polling sync, private mail, Mailer added) — releases 2A, 2B-1, 2B-2, 2C |
| 8 | Calendar | Built differently (calls and meetings are tasks; read-only private Outlook copy) — release 3C |
| 9 | Quotations | Built (3A); no price list |
| 9a | Projects | Built (3B) |
| 10 | Database | Built differently: see `docs/data-model.md` |
| 11 | Duplicate detection | Built (1B), tightened |
| 12 | Data sources and AI enrichment | Built differently: website reader + Claude Code; Places built but off; Apollo, Ollama not built — release 4 |
| 13 | User interface | Built (no Contact Enquiries screen; Mailer, Projects, Contacts added) |
| 14 | Permissions and security | Built |
| 15 | Preserve existing functionality | Void (fresh build) |
| 16–17 | Development instructions and rules | Superseded by the fresh-build design and the per-release designs; handover in `docs/DEPLOYMENT.md`, `docs/MIGRATIONS.md`, `docs/ENVIRONMENT.md` |

## 1. Project objective

Establish a company-centric CRM with independent Lead Management, public enquiry capture, integrated email, calendar
and quotations, ready for future AI-powered company research.

**This is an enhancement of an existing CRM.** Do not create a new CRM, replace the database, change the technology stack
or redesign unrelated screens. Inspect the existing application first (Section 12) and extend it.

## 2. Technology stack and hosting (fixed)

| Item | Value |
|---|---|
| Backend | Node.js (existing application; keep its framework, ORM and conventions) |
| Domain | https://crm.daitpartners.com |
| OS | AlmaLinux 9 |
| Control panel | CyberPanel |
| Web server | OpenLiteSpeed, reverse-proxying to the Node.js process |
| Database | The existing CRM database (inspect; do not migrate or recreate) |
| Background jobs | A separate Node.js worker process (enrichment, email sync, reminders) managed by PM2 or systemd on the same server |
| AI engine | Pluggable: self-hosted Ollama first; Claude API optional. Both behind one `EnrichmentProvider` interface |

Rules:
- Inspect the current application, server configuration and database before any architectural change.
- Do not migrate to a different stack or host without approval.
- Secrets (SMTP/IMAP, AI keys, Google Places key) live in server environment variables, never in the repo or the public site.
- The public Contact Us endpoint is the only unauthenticated API. Everything else requires the existing CRM session/token.

> **As built:** a new application (`2026-11-21-dait-crm-fresh-build-design.md` §4–5): Node 24, Fastify 5, Prisma 6 on
> PostgreSQL (database `dait_crm`), React + Vite frontend, npm workspaces `apps/api`, `apps/worker`, `apps/web`,
> `packages/shared`. Two PM2 processes as Linux user `daitcrm` (`crm-live` API on 127.0.0.1:3090, `crm-live-worker`)
> behind OpenLiteSpeed on the shared AlmaLinux 9 / CyberPanel server; job queue in PostgreSQL (no Redis). Sign-in with
> Microsoft 365 (Entra, PKCE) plus a break-glass local administrator. AI: Ollama was not built (no GPU on the server);
> Claude runs through the server's Claude Code CLI with a subscription token, not the paid API
> (`2026-11-23-release-4-ai-research-design.md`, addendum). Secrets are in `~/live/shared/.env` only
> (`docs/ENVIRONMENT.md`). There is no unauthenticated API at all (1D parked), apart from `/api/health` and sign-in.

## 3. Design and branding

- Primary palette (from the approved theme): `#1F0249` ink, `#6811CF` purple, `#812BE1` purple-light, `#BA5425` orange,
  `#AB4C21` orange-dark, `#F09044` peach, `#F5F1FC` background. Accent gradient `#BA5326 → #822CDB` for primary actions.
- Typography: Montserrat ExtraBold (headlines), SemiBold (labels), Regular (body). Fonts are approved as used in the prototype.
- Logo: full-colour logo on light backgrounds (public site, PDFs); the "D" mark on the dark sidebar.
- All six modules share one visual language: the sidebar, top bar, tables, badges, cards, forms and modals in `css/app.css`.
- Text contrast ≥ 4.5:1; AI-suggested values are always visibly tagged and distinguishable from verified values.

> **As built:** the prototype's `css/app.css` is ported as the global stylesheet (`apps/web/src/styles/app.css`) with
> components matching the prototype markup; no UI kit.

## 4. Module 1 — Lead Management

### 4.1 Purpose
Sales opportunities and potential customers. Two lead types in one module:
- **Lead** — has expressed interest (website form, referral, direct contact).
- **Prospect** — identified through research (directories, Google Places, CSV, LinkedIn); may have no contact details.

### 4.2 Lead creation form

| Field | Type | Mandatory |
|---|---|---|
| Lead ID | Auto-generated (existing ID strategy) | Yes |
| Lead Type | Lead / Prospect | Yes |
| Company Name | Text | Yes |
| Company | FK to companies | No (resolved by duplicate check) |
| Contact Person | FK to contacts | No |
| Company Website | URL | No |
| Business Email | Email | No |
| Phone Number | Text | No |
| Country | Dropdown (config) | Yes |
| City | Text | No |
| Lead Source | Dropdown (config) | Yes |
| Source URL | URL | No |
| Import Batch | Text (set by importers) | No |
| Assigned To | CRM user | No (allocation rules apply) |
| Lead Priority | High / Medium / Low | Default Medium |
| Lead Status | Dropdown (config) | Default New |
| Next Follow-up Date | Date | No |
| Lead Notes | Long text | No |

Lead sources: Website Contact Form, Google Places API, Company Website, Business Directory, CSV Import, Manual Entry,
Referral, LinkedIn, Other. Statuses: New, Not Contacted, Contacted, Interested, Qualified, Proposal Sent, Negotiation,
Won, Lost, Not Relevant (administrators can add more). Dropdown values come from a central configuration, never hard-coded.

### 4.3 Functionality
- Create, edit, view, archive. Search and filter by company, contact, country, source, status, assigned user, type and date.
- Assign and transfer between team members with a mandatory transfer note; full history in `lead_assignments`;
  the receiver is notified; open tasks move with the lead.
- Record calls, emails, meetings and notes (`lead_activities`); status changes are logged with from/to.
- Follow-up date automatically creates or updates a task in the owner's task list; pending and overdue views derive from tasks.
- Convert qualified leads to clients/projects without duplicating the company record. Multiple leads per company.
- **One server-side rule for Won**, whichever screen sets it (status control, call log, close dialog, accepted quotation):
  the lead becomes Won, the company is flagged Client and a single "Converted to client" activity records the previous status.
  A project is **not** created automatically; the UI offers "Mark Won and create project" as the next step.
- Closing a lead (Won, Lost, Not Relevant) clears its follow-up date and closes its open tasks, with an activity saying so,
  so overdue counts never include closed leads. Clearing a follow-up date removes the task it created.
- Unassigning a lead writes a `lead_assignments` row (to = NULL), like a transfer.
- Round-robin allocation keeps a separate position per rule and starts with the first person in the list.
- CSV and Google Places imports create Prospects and run the company duplicate check before creating any company.
- **Must stay connected to the existing task management, allocation and notification system**; extend, do not replace.

> **As built** (`2026-11-21-release-1c-leads-tasks-design.md`, `2026-11-21-leads-exact-match-design.md`,
> `2026-11-22-outreach-language-design.md`):
> - Lead IDs are `LD-1001` upward from a database sequence. Added field **Outreach language** (English / Español, default
>   from the country); allocation rules can match on it as well as country. Lead sources and statuses are lookup values.
> - Lead page actions kept: edit details, archive (confirm), transfer with mandatory note, close with reason (Lost and
>   Not Relevant need a reason), switch contact. Dropped: clone and note-less reassign. Sales Representatives also see
>   unassigned leads and can claim them; Data Research Users see prospects and their own leads.
> - The Won rule, closing rule, follow-up ↔ task sync and transfer rules are one server-side service, as specified.
>   Picking Won on the lead page opens the prototype's "Mark … as Won?" confirmation, which offers "Mark Won and create
>   project".
> - CSV import creates Prospects with the company duplicate check. **Google Places import of prospects was not built**
>   (Places exists only as an optional research source, off).
> - The Leads list bulk bar also has Assign to… and Archive (not in the prototype; kept pending the owner's decision,
>   see `docs/PENDING.md`). The lead page is contact-first as the prototype (profile, experience, education, skills,
>   languages on the contact).
> - The "existing" task / allocation / notification system did not exist; they were built new (Tasks page, Settings →
>   Lead allocation rules, in-app Notifications). Notifications are **in-app only**: no assignment, transfer or reminder
>   emails are sent.

## 5. Module 2 — Company Management

Master database of all organisations. A company is an independent entity, never a lead. One company has many contacts,
leads, prospects, projects, locations, activities, quotations, emails and calendar events.

Profile sections (fields as in v1): **A** Overview, **B** Address, **C** Size & Financial (all optional), **D** Products &
Services, **E** Digital Presence, **F** Contacts (separate `contacts` table), **G** AI Business Intelligence.

Section G fields: AI Company Summary, AI Industry Classification, AI Business Category, AI Potential Services (multi),
AI Opportunity Score (0–100), AI Confidence (High/Medium/Low), AI Research Status (Pending/Processing/Completed/Failed),
Last Research Date, Research Sources (related), Verification Status (Verified/Partially Verified/Unverified).

Rules:
- Every field carries provenance: `verified` (set by a user) or `ai` (suggested, with confidence and source).
- AI never overwrites a verified field. Suggestions are stored in `enrichment_history` and applied only when a user accepts them.
- Unknown values are stored as NULL. Nothing is invented. Clearing a field in the edit form stores NULL and removes its
  verified/AI flag, so a wrong value can be removed and AI may suggest it again.
- An AI suggestion can be decided only once (accept/reject is idempotent); only applied values count as "applied".
- Every URL from user input or enrichment (website, LinkedIn, social, research and source links) is validated on save and on
  render: only `http`, `https`, `mailto` and `tel` are allowed; anything else (e.g. `javascript:`) is rejected.
- Profile tabs: Overview, Contacts, Locations, Leads & Prospects, Activities, AI Intelligence, Research Sources.

> **As built** (`2026-11-21-release-1b-companies-contacts-design.md`, `2026-11-23-release-4-ai-research-design.md`):
> company numbers `CO-0001` from a sequence; Companies list with tiles, tabs (including **Duplicate review**), filters
> and pager; Contacts are both a company tab and their own page, with Deactivate and Move to another company; exactly
> one primary contact per company (database index). The profile also has a **Projects** tab (release 3B).
> Deactivate (Inactive / Closed) instead of delete. Suggestions are stored in `enrichment_suggestions` (one row each)
> linked to `enrichment_runs`, not a JSON column; research proposes values only for **empty, unverified** fields and
> never touches verified ones. AI Research Status adds "Not started" (never researched). Without Claude, the AI summary,
> classification and opportunity score stay empty ("not yet computed").

## 6. Module 3 — Website Contact Us form

Public form on daitpartners.com, separate from the CRM lead form. Exactly six fields: Full Name*, Business Email*,
Phone, Company Name*, Company Website, Requirement/Message*. Do not ask for industry, size, revenue, address, employee
count, registration details, LinkedIn or description.

Submission workflow (server side, synchronous part must return within ~1 s):
1. Validate; reject honeypot / rate-limit / token failures; store the **immutable** `contact_enquiries` record.
   Enforce immutability in the database, not only in the UI: the submitted columns are never updated (no UPDATE grant on
   them, or a trigger that rejects changes); only processing columns (status, trace, linked ids) may change.
2. Identify the company by website domain, then business-email domain (ignore free-mail domains), then legal name,
   then normalised name + country. Exact matches link; uncertain matches go to **Needs review** (no lead yet).
3. Create the company if nothing matched. 4. Match or create the contact (email → phone → name + company).
5. Create a new Lead (Type Lead, Source Website Contact Form, Status New, AI enrichment Pending) — always a new lead,
   even when company and contact exist.
6. Apply allocation rules, notify the owner, add a follow-up task. 7. Return confirmation to the visitor. Enrichment runs later.

Spam protection: honeypot field, per-IP rate limiting, server-issued form token, optional CAPTCHA. The public site calls one
public endpoint only; it never receives CRM API keys or database access.

> **Not built.** Release 1D (public form, `contact_enquiries`, Enquiries screen with the Needs-review queue) is **parked
> by the owner** ("keep contact in pending, i will decide lateron", 22 Nov 2026). daitpartners.com/contact keeps its own
> form (contact.php → Mailjet). The design for when it is picked up is in `2026-11-21-dait-crm-fresh-build-design.md` §5
> (form served at crm.daitpartners.com/contact, `POST /api/public/enquiries`, company auto-linked only on an exact
> business-email domain, everything else to Needs review). Ready in the code: the CSRF guard already exempts
> `/api/public/` and `leads.enquiry_id` exists as a plain column. The Reports page's "Enquiry conversion" card shows 0s
> until then.

## 7. Module 4 — Email Management

- Send and receive email inside the CRM (per-user SMTP/IMAP or Microsoft Graph / Gmail API; inspect what the existing
  CRM already integrates and extend it).
- Every message links to a Lead, Contact and Company (auto-matched on sender address; manual link for unknown senders;
  "create lead from email" runs the company duplicate check).
- Folders: Inbox, Sent, Drafts, Archive. Smart views: Unlinked, Awaiting reply, My leads. Templates with merge fields.
- Sending from a lead/quotation logs a `lead_activities` row; replies update the thread history.
- Email notifications for assignments, transfers, reminders and accepted quotations use the same transport.

**Microsoft 365 connection (required).** DAIT Partners uses Microsoft 365 Business Basic, which includes Exchange Online, so
mail and calendar are integrated through the **Microsoft Graph API**, not IMAP:
- One-time app registration in Microsoft Entra (single tenant): app "DAIT CRM", redirect URI
  `https://crm.daitpartners.com/api/auth/microsoft/callback`, delegated permissions `Mail.ReadWrite`, `Mail.Send`,
  `Calendars.ReadWrite`, `User.Read`, `offline_access`; an administrator grants tenant-wide consent once.
- Each user connects their own mailbox from Settings → Email & calendar connections: OAuth 2.0 authorization code flow with
  PKCE; the password is entered on Microsoft's page only. The CRM stores the refresh token encrypted (AES-256, key in the server
  environment) in `email_accounts`; access tokens are refreshed server-side and never sent to the browser.
- Sync: initial import of the last 90 days (inbox + sent), then continuous via Graph change notifications (webhook subscriptions
  renewed by the worker) with delta queries as fallback. Sending uses `/me/sendMail` so sent items appear in Outlook too.
- Calendar: two-way sync of `calendar_events` with the user's Outlook calendar (`/me/events`, delta sync, `external_id` holds the
  Graph event id); CRM meetings create Outlook events with invites; Outlook events linked to known contacts appear in the CRM.
- Shared mailboxes (e.g. hello@daitpartners.com) can be included when the user has delegated access.
- Google Workspace (Gmail + Calendar APIs) and generic IMAP/SMTP use the same `email_accounts` table and provider interface.
- Server environment variables: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `MS_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`.
  Disconnecting deletes the tokens and the Graph subscriptions; emails already linked to records remain in the CRM.

**Email templates, including Outlook .oft files.** Settings → Email templates lets users write templates in the CRM or upload
Outlook templates (`.oft`, also `.msg`). The server parses the file (OLE compound file with MAPI properties: subject
`0037`, text body `1000`, HTML body `1013`) with a msg/oft parser package, stores subject, text and HTML in `email_templates`,
and keeps the original file. Merge fields `{first_name}`, `{company}`, `{me}`, `{quote_no}`, `{lead_id}` are filled when the
template is used. Templates carry a language; the user's language is listed first in every compose box.

Tables: `email_accounts` (per user, encrypted credentials), `email_messages` (message_id, thread_id, folder, from, to,
subject, body, received_at, lead_id, contact_id, company_id, quotation_id), `email_templates`.

> **As built** (`2026-11-22-release-2a-connections-templates-design.md`, `2026-11-22-release-2b-email-design.md`,
> `2026-11-22-release-2b2-sync-email-screen-design.md`, `2026-11-22-release-2c-mailer-design.md`):
> - **Microsoft 365 only** (owner's choice); Google Workspace and IMAP show "Coming later". One Entra app serves sign-in
>   and mail. A **system mailbox** (connected by an administrator) exists for CRM mail; each user connects their own
>   **personal mailbox** in Settings → Email & calendar connections. Refresh tokens are AES-256-GCM encrypted.
> - **Privacy rule (owner):** a user's mail is visible only to that user, administrators included. On the lead timeline
>   others see only "Email sent · by {name}", the sender also sees the subject.
> - **Sync polls Graph** with delta queries every 5 minutes per folder (inbox, sent, drafts, archive; last 90 days), not
>   change-notification webhooks. Bodies are plain text; attachments are listed by name, not downloaded; drafts are view
>   only; shared mailboxes are stored in Options but not synced.
> - Email screen as the prototype: folders, smart views, search, reader, Reply, Log as activity, linked records, create
>   lead from email, Compose with Client → Lead → Project; pager (owner request). Emailing a New / Not Contacted lead
>   moves it to Contacted.
> - Templates: written in the CRM or read from an uploaded `.oft` / `.msg` (parsed in the browser); the file itself is
>   not kept; plain-text body; merge fields `{first_name}`, `{company}`, `{me}`, `{lead_id}`, `{quote_no}`.
> - **Added: the Mailer** (release 2C): a template sent to ticked leads one by one from the sender's mailbox, spaced 1–15
>   minutes, optionally only in the **client's** working hours (Mon–Fri 09:00–18:00 in the recipient's time zone), at
>   most 200 per mailbox per day, with Do not email / unsubscribe and an audit row per recipient.
> - No assignment / transfer / reminder emails (notifications are in-app). The system mailbox sends the test email.
> - `email_messages` has no `quotation_id`; it has `project_id` (release 3B).

## 8. Module 5 — Calendar Management

- Day / week / month views; event types Meeting, Call, Appointment, Follow-up, Internal.
- Events link to Lead, Company and Contact; attendees can be CRM users (assigned, notified) and external contacts (invite email).
- Reminders (in-app + email) feed the existing notification system; follow-up tasks appear on the calendar.
- Team view for managers. Future: Microsoft Outlook and Google Calendar two-way sync via a `calendar_connections` table;
  the data model must not change when sync is added.

Tables: `calendar_events` (title, type, starts_at, ends_at, timezone, location, organiser_id, lead_id, company_id,
contact_id, reminder_minutes, external_id), `calendar_event_attendees` (event_id, user_id or contact_id, status).

> **As built** (`2026-11-22-release-3c-calendar-design.md`): calls and meetings planned in the CRM are **tasks** with a
> type and a time (call 30 min, meeting 60 min), so they appear on Tasks, overdue counts, the dashboard and the lead
> timeline. Each user's own Outlook calendar is copied read-only every 5 minutes into a private `calendar_events` table
> (when Sync calendar is on); nobody else sees it, administrators included. **Nothing is written to Outlook**: no
> invitations, no attendees, no Outlook events created from the CRM. Day / Week / Month views, mini month, Overdue list
> and New follow-up dialog as the prototype; the Mine / Everyone switch is for Administrators only and Everyone shows
> the team's CRM tasks, never their Outlook events. Not built: event types beyond follow-up / call / meeting,
> `calendar_event_attendees`, `calendar_connections`, reminders and invite emails, Google Calendar.

## 9. Module 6 — Quotation Management

- Create, edit, send and track quotations linked to Lead, Company and Contact.
- Fields: quotation number (auto, sequential per year), date, validity date, currency, subject, line items (item, description,
  quantity, unit, unit price, line discount), overall discount, tax rate, notes/terms, status, owner.
- Statuses: Draft, Sent, Negotiating, Accepted, Rejected, Expired (config). Expiry is computed from the validity date.
- Sending generates a PDF (server-side), emails it through Module 4, logs an activity, moves an early-stage lead to
  Proposal Sent and **freezes the revision**. Any edit after sending opens a new revision; previous versions remain viewable.
- Accepted → lead Won, company flagged Client; "Convert to project" creates the project/client record from the quotation
  without creating a new company or contact.
- Validation: quantity and unit price ≥ 0; line discount, overall discount and tax rate between 0 and 100 %.
- A quotation cannot be sent without a contact that has an email address. Accepted, Rejected and Expired quotations are
  read-only. Only an Accepted quotation can be converted, and only once (a second request returns the existing project).
- IDs: business numbers (lead, company, quotation, project) come from database sequences; never from timestamps or row counts.

Tables: `quotations` (number, company_id, contact_id, lead_id, owner_id, status, currency, tax_rate, overall_discount,
valid_until, notes, current_revision), `quotation_revisions` (quotation_id, revision_no, total, pdf_path, sent_at, snapshot_json),
`quotation_lines` (revision_id, item, description, qty, unit, unit_price, discount_pct), `price_list_items`, `projects`.

> **As built** (`2026-11-22-release-3a-quotations-design.md`): numbers `Q-YYYY-NNN` per calendar year. Currencies
> **USD, CAD and INR** only (default from the client's country: India → INR, Canada → CAD, else USD); one **GST** line
> (default 18 % on INR, 0 % on USD / CAD, from Settings → Company details); no exchange rates. One issuer (DAIT Partners
> LLP, Delhi) for every currency. The PDF is drawn on the server with pdfkit (no browser) and is not stored: it is
> redrawn from the revision's frozen snapshot. A quotation counts as sent only when Microsoft confirms the email from
> the sender's own mailbox ("Sending…" until then); the sent email is the sender's private mail. `quotation_lines` hold
> the working copy (not per revision); each send freezes a `quotation_revisions` row. Rejecting never changes the lead's
> status. Expired is set automatically by the worker after the valid-until date. Settings → Company details (issuer,
> GSTIN, default GST per currency, default notes) was added. **Not built:** `price_list_items` (not in the prototype),
> CGST / SGST split, invoices, client acceptance page.

## 9a. Projects (client engagements)

- A company becomes a **Client** when a lead is marked Won or a quotation is accepted. From then on the lead page, the company
  profile (Projects tab) and the Projects module show a **Create project** button and the list of projects.
- One client can have many projects; each project records the lead it came from (`lead_id`), the linked quotation, status
  (Active / On hold / Completed / Cancelled), start date, value and currency, project manager and **primary stakeholders**
  (contacts at the client). Stakeholders default to the lead's contact plus the client's primary / decision-maker contacts.
- **Email context.** Every compose box starts with Client → Lead → Project selectors (lead and project lists narrow to the chosen
  client). The lead contact goes in To, the project's primary stakeholders are pre-filled in Cc with per-person tick boxes, and the
  sent email is stored with `company_id`, `lead_id` and `project_id` so it appears on all three records. The Email page filters by
  Client, Lead and Project.

> **As built** (`2026-11-22-release-3b-projects-design.md`): numbers `PRJ-<n>`. Projects page (tiles, Client / Status
> filters, Email a project, Create project), Create / Edit project dialog, Projects cards on the lead page and company
> Overview, company Projects tab, "Mark Won and create project", **Convert to project** on an accepted quotation (once;
> value = net before GST). No project detail page (the prototype has none); projects are never deleted (Cancelled is
> the end state); a project's client cannot change. The project tag on an email never widens who sees it: mail stays
> private to its owner, and the Project filter only narrows the viewer's own mail. Client names show the legal name
> where set (owner, 23 Nov 2026).

## 10. Common database architecture

One shared relational database (the existing one), extended by migrations. Core tables:

| Table | Purpose |
|---|---|
| companies | Master company information (+ `verified_fields` JSON, AI fields) |
| contacts | People associated with companies |
| leads | Leads and prospects |
| company_locations | Multiple business locations |
| contact_enquiries | Original Contact Us submissions (immutable) |
| lead_activities | Calls, emails, meetings, notes, status changes |
| lead_assignments | Assignment and transfer history |
| tasks | Follow-up and task management (existing table, extended) |
| enrichment_history | AI research runs and suggestions (`suggestions_json`, decisions) |
| source_records | Source URLs, snapshots and collected information |
| email_accounts, email_messages, email_templates | Module 4 |
| calendar_events, calendar_event_attendees, calendar_connections | Module 5 |
| quotations, quotation_revisions, quotation_lines, price_list_items, projects | Module 6 |
| lookup_values | Central dropdown configuration (sources, statuses, industries, …) |
| allocation_rules | Lead allocation rules |
| audit_log | Who changed what, when |

Relationships: Company 1–n Contacts, Leads, Locations, Enrichment runs, Quotations, Events, Emails. Contact 1–n Leads.
Lead 1–n Activities, Tasks, Assignments, Quotations, Events, Emails. Enquiry → Lead, Contact, Company (traceable).
Quotation 1–n Revisions 1–n Lines. Use the existing ID strategy; add foreign keys and indexes on every FK, on
`companies.domain`, `contacts.email`, `leads.status`, `leads.assigned_to`, `tasks.due_date`.

> **As built:** see `docs/data-model.md` (column level, matches `prisma/schema.prisma`) and `docs/MIGRATIONS.md`.
> Differences from the table above: `enrichment_history` is `enrichment_runs` + `enrichment_suggestions`;
> `contact_enquiries`, `calendar_event_attendees`, `calendar_connections` and `price_list_items` do not exist; added
> `users`, `sessions`, `jobs`, `notifications`, `email_campaigns`, `email_campaign_recipients`, `project_stakeholders`,
> `company_settings`, `enrichment_settings`; the audit table is `audit_logs`. Integer ids; `LD-` and `CO-` numbers from
> sequences, `Q-` and `PRJ-` numbers from per-year / global counters under an advisory lock.

## 11. Duplicate detection

Company priority: 1 exact website domain, 2 exact legal name, 3 normalised name + country, 4 manual review.
Contact priority: 1 exact email, 2 normalised phone, 3 name + company. Never merge on similar names alone; show the existing
record and let an authorised user decide. A new enquiry still creates a new lead when company and contact exist.
Duplicate review queue lives under Companies.

> **As built** (`2026-11-21-release-1b-companies-contacts-design.md`): only the first key links automatically — company
> on the business-email / website **domain** (free-mail domains ignored), contact on exact email; legal-name,
> name + country, phone and name + company matches are shown as "possible duplicates" for the user to decide, live on
> the create forms. The Companies list has a **Duplicate review** tab. Nothing is ever merged automatically.

## 12. Data sources and AI enrichment

Supported sources: public company websites, approved Google Places API, licensed directories, CSV imports, other permitted
public sources (Apollo.io and web search optional). Enrichment is a background job: new company/lead → job queued →
website identified → information collected → AI analysis → structured JSON (value + confidence + source per field) →
validation → suggestions stored → verified fields untouched → sources recorded → owner notified.
Provider interface: `analyse(companyContext) → { fields: { name: { value, confidence, source } }, summary, score }`.
Ollama (self-hosted) and Claude API implement it; switching providers is configuration only.

> **As built** (`2026-11-23-release-4-ai-research-design.md` and its 23 Nov addendum): research is a worker job
> (`research_company`, its own lane, one run at a time), started by hand ("Run AI research") or automatically when a
> lead is created for a company with a website that was never researched. Providers:
> - **Website reader** (free, always on): reads the company's own public site (robots.txt respected, private addresses
>   refused) and proposes values for empty, unverified fields only, each with its source page.
> - **Claude Code on this server** (built; off until an Administrator switches it on with a monthly run cap above 0):
>   the server's `claude` CLI with a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`), not the paid Claude API. Adds
>   summary, classification, potential services, opportunity score, website assessment; optional **Web search** source.
> - **Google Places API** (built, off; needs `GOOGLE_PLACES_API_KEY`, a switch and a monthly call cap).
> - **Not built:** Ollama (no GPU on the shared server; shown "not installed"), Apollo.io (needs a paid plan; shown "not
>   connected"), public registries, research on contacts, scheduled re-research.
> Users Accept / Reject each suggestion (or "Accept all ≥ 80%"); accepted values are applied, rejected ones kept in the
> history; every page read becomes a Research Sources record with a read-only snapshot. A daily run limit (default 50,
> UTC day) caps runs. The owner is notified when a run finishes.

## 13. CRM user interface

Sidebar: Dashboard · **Leads · Companies · Contact Enquiries · Email · Calendar · Quotations** · Tasks · Reports · Settings.
Screens and columns as in v1 for Leads, Companies (with the seven profile tabs) and Contact Enquiries; plus Email (folders,
list, reader, linked-records rail), Calendar (week view default, event editor), Quotations (list, editor with live totals,
revisions, status, PDF preview). The Dashboard shows the current user's tasks (overdue/today/upcoming), today's agenda,
notifications and pipeline. See the design canvas and prototype for layouts.

**Screens match the prototype (added 21 Nov 2026).** Every screen reproduces the layout, sections, section order and
visual structure of its prototype view (`prototype/index.html`, `prototype/js/views-*.js`). Panels for features that ship in
a later release are rendered in their prototype position as muted placeholder cards ("Available in release N"). The lead
page is contact-first as in the prototype: profile header with headline, experience, skills and languages (new `contacts`
columns), compose panel, Follow-up / Emails / Calls tabs, company card with verification and AI summary, projects, coming
up, original enquiry. Acceptance for each screen is a side-by-side comparison with the prototype at the same viewport.

**Dropdown rule.** Every dropdown with eight or more options (country, company, contact, lead, industry, status, source,
lookup lists, list-page filters, modal selects) is a searchable combobox: type to filter, matches highlighted, arrow keys and
Enter to pick, Escape to close, keyboard and screen-reader accessible (`role="combobox"` + listbox). Short lists stay plain
selects. One shared component; see `UI.enhanceSelects` in the prototype for the reference behaviour.

**Languages.** The CRM ships in English (default), Spanish and French. Each user picks a language under Settings →
Preferences (`users.language`); the interface, statuses, dropdown labels, validation messages, notifications and date/number
formats follow it immediately. Implementation: one JSON resource file per language (`locales/en.json`, `es.json`, `fr.json`)
with the English phrase as the key; lookup values keep a `label_es` / `label_fr` beside `label`; email templates and PDF
quotation layouts exist per language; the public Contact Us form reads the visitor's browser language with a manual switch.
Adding a language means adding a resource file, no code changes.

> **As built:** sidebar Dashboard · Leads · Companies · **Contacts** · Email · **Mailer** · Calendar · Quotations ·
> **Projects** · Tasks · Notifications · Reports · Settings. There is **no Contact Enquiries** screen (1D parked).
> Email and Mailer show only to users with the email right. Reports is the prototype's view only (Leads by source,
> Enquiry conversion at 0 until 1D; `2026-11-22-reports-design.md`). The Calendar opens on the month view (the spec said week), as the
> prototype. Combobox rule and the three languages are built: `apps/web/src/locales/en.json`, `es.json`, `fr.json`
> keyed by English phrase, lookup labels with `label_es` / `label_fr`; a translation check runs in CI. Templates carry a
> language; the quotation PDF wording follows the quotation owner's language. Deliberate screen differences from the
> prototype the owner accepted or still has to confirm are listed in `docs/PENDING.md`.

## 14. Permissions and security

Respect the existing role system. Suggested: Administrator (full, config, merges, engine), Manager (team leads, companies,
quotations, transfers), Sales Representative (assigned leads and their companies; own email, calendar, quotations),
Data Research User (prospects, companies, research records). Audit logging on create/update/delete of all new entities.
Validate all input server-side; protect the public endpoint (Section 6).

> **As built** (`2026-11-21-dait-crm-fresh-build-design.md` §5, `2026-11-21-release-1c-leads-tasks-design.md`): the
> four roles, enforced in the API (a hidden row answers 404). Administrator and Manager see all leads; Sales
> Representative sees own and unassigned leads (can claim) and their companies; Data Research User sees prospects, own
> leads, companies and research, no quotations or email. Only Administrators edit Settings, Company details and the
> Enrichment engine. **Mail and Outlook calendar are private to their owner, administrators included** (owner rule).
> Every write is validated with Zod and audited; every editable record uses `updated_at` concurrency (409 on a stale
> write); every browser write must come from the site's own origin; only `http`, `https`, `mailto`, `tel` URLs are
> accepted.

## 15. Existing functionality that must be preserved

User management, role-based permissions, lead allocation, lead transfer and notifications, task management, pending and
overdue tasks, follow-up scheduling, status updates, activity history, dashboard and reporting, and any existing email or
communication integration. Extend rather than replace.

> **Void:** there was no existing CRM (fresh build). Each of these was built new: users and roles (Settings → Users),
> allocation rules, transfers, in-app notifications, tasks, follow-ups, activity history, dashboard, reports.

## 16. Development instructions

**Phase 1 — Inspect:** project structure, framework, ORM, database schema, auth/roles, existing Lead/Company/Contact/Task
code, API routes, UI components, allocation and notification workflows, server config (OpenLiteSpeed vhost, CyberPanel,
Node process manager).
**Phase 2 — Plan (wait for approval):** architecture summary, reusable components, migrations, API changes, new screens,
conflicts, integration plan for Email, Calendar and Quotations with the existing auth, permissions, notifications and history.
**Phase 3 — Database:** migrations only; tables, FKs, indexes, lookup values, audit; preserve all records.
**Phase 4 — Frontend:** the six modules, following the brand theme and the prototype's component language.
**Phase 5 — Backend/API:** CRUD for leads, companies, contacts, locations, enquiries (public POST), emails, events,
quotations; duplicate detection; allocation/transfer/task/notification integration; enrichment worker and provider interface;
PDF generation; email transport.
**Phase 6 — Testing:** the 13 v1 scenarios plus: email linked to correct lead; unlinked email → lead with duplicate check;
event reminder notifies attendees; quotation send freezes revision; edit after send creates revision; accept → Won + Client;
convert → project; verified field survives enrichment; public endpoint rejects honeypot and rate-limit abuse; Won from the
call log flags the client; Lost closes open tasks; `javascript:` URLs are rejected; a quotation converts only once.
**Phase 7 — Handover:** modifications, migrations, endpoints, components, relationships, test results, limitations,
deployment steps for AlmaLinux 9 / CyberPanel / OpenLiteSpeed (vhost proxy, PM2/systemd units, env vars, log paths).

> **As run:** inspection (Phase 1) was dropped (fresh build). The work followed `docs/development-plan.md` releases
> 1–4, each with its own design in `docs/superpowers/specs/`, built with unit, API and end-to-end tests plus
> side-by-side prototype screenshots, and deployed to live by hand when the owner said "deploy" (there is no test copy
> on the server). The public-endpoint tests in Phase 6 do not apply while 1D is parked. Handover: `docs/DEPLOYMENT.md`
> (server, deploy, rollback, backup, restore, logs), `docs/MIGRATIONS.md`, `docs/ENVIRONMENT.md`,
> `docs/data-model.md`, `deploy/openlitespeed.md`, and the owner's list in `docs/PENDING.md`.

## 17. Development rules

Do not rebuild the CRM, replace the database, remove functionality, create separate company databases per source, combine
Lead and Company, combine the public form with the internal lead form, require complete company data for a prospect,
overwrite verified data with AI findings, or hard-code dropdown values. Use migrations, reusable components, audit logging,
and keep backward compatibility with existing records and APIs.

## 18. Expected result

Six clearly separated modules on one integrated CRM with common authentication, permissions, notifications, activity history
and record relationships: Leads, Companies, Contact Enquiries, Email, Calendar, Quotations — company-centric, duplicate-safe,
and ready for self-hosted AI research.

*End of specification v2.*
