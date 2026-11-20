# DAIT Partners CRM — Enhancement & Development Specification (v2)

**Implementation instructions for Claude Code**
**Project:** DAIT Partners Custom CRM · https://crm.daitpartners.com
**Objective:** Enhance the existing Node.js CRM with six integrated modules: Lead Management, Company Management,
Website Contact Us Form, Email, Calendar and Quotation Management, on the existing hosting environment.

Companion material: the design canvas (18 screens) and the HTML/CSS/JS prototype in this repository
(`index.html`, `js/store.js` for the business rules). Where this document and the prototype differ, this document wins.

---

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

## 3. Design and branding

- Primary palette (from the approved theme): `#1F0249` ink, `#6811CF` purple, `#812BE1` purple-light, `#BA5425` orange,
  `#AB4C21` orange-dark, `#F09044` peach, `#F5F1FC` background. Accent gradient `#BA5326 → #822CDB` for primary actions.
- Typography: Montserrat ExtraBold (headlines), SemiBold (labels), Regular (body). Fonts are approved as used in the prototype.
- Logo: full-colour logo on light backgrounds (public site, PDFs); the "D" mark on the dark sidebar.
- All six modules share one visual language: the sidebar, top bar, tables, badges, cards, forms and modals in `css/app.css`.
- Text contrast ≥ 4.5:1; AI-suggested values are always visibly tagged and distinguishable from verified values.

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

## 8. Module 5 — Calendar Management

- Day / week / month views; event types Meeting, Call, Appointment, Follow-up, Internal.
- Events link to Lead, Company and Contact; attendees can be CRM users (assigned, notified) and external contacts (invite email).
- Reminders (in-app + email) feed the existing notification system; follow-up tasks appear on the calendar.
- Team view for managers. Future: Microsoft Outlook and Google Calendar two-way sync via a `calendar_connections` table;
  the data model must not change when sync is added.

Tables: `calendar_events` (title, type, starts_at, ends_at, timezone, location, organiser_id, lead_id, company_id,
contact_id, reminder_minutes, external_id), `calendar_event_attendees` (event_id, user_id or contact_id, status).

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

## 11. Duplicate detection

Company priority: 1 exact website domain, 2 exact legal name, 3 normalised name + country, 4 manual review.
Contact priority: 1 exact email, 2 normalised phone, 3 name + company. Never merge on similar names alone; show the existing
record and let an authorised user decide. A new enquiry still creates a new lead when company and contact exist.
Duplicate review queue lives under Companies.

## 12. Data sources and AI enrichment

Supported sources: public company websites, approved Google Places API, licensed directories, CSV imports, other permitted
public sources (Apollo.io and web search optional). Enrichment is a background job: new company/lead → job queued →
website identified → information collected → AI analysis → structured JSON (value + confidence + source per field) →
validation → suggestions stored → verified fields untouched → sources recorded → owner notified.
Provider interface: `analyse(companyContext) → { fields: { name: { value, confidence, source } }, summary, score }`.
Ollama (self-hosted) and Claude API implement it; switching providers is configuration only.

## 13. CRM user interface

Sidebar: Dashboard · **Leads · Companies · Contact Enquiries · Email · Calendar · Quotations** · Tasks · Reports · Settings.
Screens and columns as in v1 for Leads, Companies (with the seven profile tabs) and Contact Enquiries; plus Email (folders,
list, reader, linked-records rail), Calendar (week view default, event editor), Quotations (list, editor with live totals,
revisions, status, PDF preview). The Dashboard shows the current user's tasks (overdue/today/upcoming), today's agenda,
notifications and pipeline. See the design canvas and prototype for layouts.

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

## 14. Permissions and security

Respect the existing role system. Suggested: Administrator (full, config, merges, engine), Manager (team leads, companies,
quotations, transfers), Sales Representative (assigned leads and their companies; own email, calendar, quotations),
Data Research User (prospects, companies, research records). Audit logging on create/update/delete of all new entities.
Validate all input server-side; protect the public endpoint (Section 6).

## 15. Existing functionality that must be preserved

User management, role-based permissions, lead allocation, lead transfer and notifications, task management, pending and
overdue tasks, follow-up scheduling, status updates, activity history, dashboard and reporting, and any existing email or
communication integration. Extend rather than replace.

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
