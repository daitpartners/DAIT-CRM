# DAIT Partners CRM — Data model (column level)

As built, 23 Nov 2026: one PostgreSQL database (`dait_crm`), defined by `prisma/schema.prisma` and created by the
migrations listed in `docs/MIGRATIONS.md`. When this document and the schema differ, the schema wins.

Conventions:
- Every table is new (the CRM was a fresh build; there was no existing CRM to extend). Primary keys are integer
  `id SERIAL` unless noted. Business numbers come from sequences or per-year counters, never from row counts.
- Column names are snake_case in the database (camelCase in Prisma). "text" means PostgreSQL `text` (Prisma `String`
  without a length); timestamps are `timestamp(3)` in UTC.
- `created_at` / `updated_at` are listed where they exist; `updated_at` doubles as the optimistic-concurrency token
  (writes send the value they loaded; a stale write gets 409).
- Allowed values in the notes come from the shared package (`packages/shared`) or `lookup_values`; the database stores
  them as text, without enums, except `users.role`.
- Every create / update / delete of a business record also writes an `audit_logs` row.

## Module 2 — Company Management

### companies
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| number | text | `CO-0001` …, **unique**; default `next_company_number()` over sequence `company_number_seq` (migration SQL); padding grows past 4 digits |
| name | text | required |
| name_normalised | text | normalised name, set on every write; index with `country` for duplicate matching |
| legal_name | text | |
| website | text | |
| domain | text | from website, else business email; **unique index**; first duplicate-check key |
| business_email | text | |
| industry | text | lookup `industry` |
| business_category | text | lookup `business_category` |
| business_type | text | lookup `business_type` |
| year_established | smallint | |
| description | text | |
| logo_path | text | not used by any screen yet |
| linkedin_url | text | |
| status | text | Active / Inactive / Closed, default Active; index |
| is_client | bool | set when a lead is Won or a quotation accepted; Administrators / Managers may edit |
| country, state, city, street, zip | text | HQ address; `country` required, indexed |
| timezone | text | IANA zone; used by the Mailer's working hours; one-time fill from the address (release 2C) |
| lat, lng | decimal(9,6) | |
| maps_url | text | |
| employee_count | int | |
| employee_range | text | lookup `employee_range` |
| annual_revenue | decimal(18,2) | |
| revenue_currency | char(3) | |
| revenue_range | text | lookup `revenue_range` |
| ownership_type | text | lookup `ownership_type` |
| registration_number | text | index |
| stock_exchange, stock_symbol | text | |
| main_products, main_services | text | |
| business_verticals, target_markets, geographic_markets | jsonb array | default `[]` |
| key_brands | text | |
| specialisation | text | |
| social_facebook, social_instagram, social_x, social_youtube, social_other | text | |
| website_technology | text | research may fill it |
| website_assessment, digital_summary | text | Claude may fill them |
| ai_summary | text | Claude |
| ai_industry, ai_business_category | text | Claude |
| ai_potential_services | jsonb array | Claude; default `[]` |
| ai_opportunity_score | smallint 0–100 | Claude |
| ai_confidence | text | High / Medium / Low |
| ai_research_status | text | Not started / Pending / Processing / Completed / Failed, default Not started |
| ai_last_research_at | timestamp | |
| verification_status | text | Verified / Partially Verified / Unverified, default Unverified |
| verified_fields | jsonb | `{ "industry": true, ... }` — fields a user confirmed; research never suggests for these |
| ai_fields | jsonb | fields currently holding an accepted research value, with confidence and source |
| created_by_id | FK users, nullable | set null on user delete |
| created_at, updated_at | timestamp | |

Indexes: `name`, (`name_normalised`, `country`), `country`, `status`, `registration_number`, unique `number`, unique
`domain`.

### contacts
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | required; restrict delete |
| first_name, last_name | text | index (`company_id`, `last_name`) |
| designation, department | text | |
| business_email | text | index; first contact-match key |
| phone, mobile | text | stored raw |
| phone_normalised, mobile_normalised | text | digits only; indexed; second contact-match key |
| linkedin_url | text | |
| contact_type | text | lookup `contact_type`, default Other |
| is_primary | bool | at most one per company: partial unique index `contacts_one_primary_per_company` (migration SQL) |
| unsubscribed_at | timestamp, nullable | set with a lead's Do not email (release 2C); the Mailer skips the contact |
| is_active | bool | default true; deactivated contacts are hidden from pickers (release 1C) |
| headline, location | text | lead page profile header (prototype parity) |
| about | text | |
| experience | jsonb array | `[ { title, company, from, to, description } ]` |
| education | jsonb array | `[ { school, degree, from, to } ]` |
| skills, languages | jsonb array of strings | |
| created_at, updated_at | timestamp | |

### company_locations
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | cascade delete; index |
| name | text | |
| location_type | text | lookup `location_type` (Headquarters / Branch / Warehouse / Registered office / Factory) |
| country, state, city, street, zip, timezone | text | `country` required |
| lat, lng | decimal(9,6) | |
| maps_url, phone | text | |
| is_verified | bool | |
| source | text | default Manual |
| created_at, updated_at | timestamp | |

### enrichment_runs (was planned as `enrichment_history`)
One row per research run on a company (release 4). Suggestions are their own table instead of a JSON column.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | cascade delete; index (`company_id`, `created_at`) |
| lead_id | FK leads, nullable | the new lead that triggered an automatic run |
| trigger | varchar(120) | "Manual · <user>", "New lead LD-…" |
| engine | varchar(120) | "Website reader", "Website reader + Claude Code <model>" |
| sources | jsonb array | sources used: website, places, websearch |
| result | text | "n suggestions", "No website on file", or the error shown in the history |
| applied_count | int | |
| status | varchar(20) | Pending / Processing / Completed / Failed, default Pending |
| error | text | |
| cost_usd | decimal(10,4) | always 0 (Claude Code runs on a subscription); kept for the history |
| places_calls | int | Google Places Place Details calls made; summed per month against the call cap |
| started_at, finished_at | timestamp | |
| created_by_id | FK users, nullable | |
| created_at | timestamp | index |

### enrichment_suggestions
A value a run proposes for one empty, unverified company field.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| run_id | FK enrichment_runs | cascade delete; index |
| company_id | FK companies | cascade delete; index (`company_id`, `decision`) |
| field | varchar(40) | research field key (shared `RESEARCH_FIELDS`) |
| label | varchar(80) | |
| value | jsonb | |
| display | text | how a non-string value reads in the table |
| confidence | smallint | 0–100 |
| source_url | text | the page it came from (required) |
| source_label | varchar(200) | |
| decision | varchar(12) | pending / accepted / rejected / superseded, default pending; decided once |
| decided_by_id | FK users, nullable | |
| decided_at | timestamp | |

### source_records
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | cascade delete; index (`company_id`, `collected_at`) |
| lead_id | FK leads, nullable | |
| title | varchar(200) | |
| url | varchar(500) | |
| source_type | varchar(40) | Company website / Google Places API / Public registry / Business directory / Social profile / Contact form / Manual research / CSV import; manual records also allow Other |
| collected_at | timestamp | |
| collected_by | varchar(120) | "Enrichment worker" or "<user> (manual)" |
| fields_populated | varchar(500) | |
| confidence | varchar(20) | |
| snapshot | text | read-only extract (first 4,000 visible characters of a page, or manual notes) |

### enrichment_settings
Single row (`id` = 1, CHECK in the migration SQL), seeded by the migration. Administrators edit it in the Enrichment
engine card. API keys and tokens are never stored here (server environment, see `docs/ENVIRONMENT.md`).

| Column | Type | Notes |
|---|---|---|
| id | int PK | always 1 |
| daily_run_limit | int | research runs per day across the CRM (UTC day), default 50 |
| claude_enabled | bool | default false |
| claude_monthly_run_cap | int | runs that use Claude Code per calendar month (UTC); 0 = Claude off |
| places_enabled | bool | default false |
| places_monthly_call_cap | int | Place Details calls per calendar month; 0 = Places off |
| web_search_enabled | bool | default false; needs Claude Code |
| updated_at | timestamp | |
| claude_monthly_cap_usd | decimal | **in the table only** (not in the Prisma schema); unused since the Claude Code change; drop in a later migration |

## Module 1 — Lead Management

### leads
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| number | text | `LD-1001` …, **unique**; default `next_lead_number()` over sequence `lead_number_seq` |
| lead_type | text | Lead / Prospect, default Lead; index |
| company_name | text | required |
| company_id | FK companies, nullable | restrict delete; index |
| contact_id | FK contacts, nullable | set null |
| website, business_email, phone | text | |
| country | text | required; index |
| city | text | |
| lead_source | text | lookup `lead_source`, required |
| outreach_language | char(2) | `en` / `es`, default `en`; default by country for new leads; allocation rules may match it |
| source_url | text | |
| import_batch | text | e.g. `IMPORT-2026-11-21` |
| assigned_to_id | FK users, nullable | set null; index |
| priority | text | High / Medium / Low, default Medium |
| status | text | lookup `lead_status`, default New; index |
| next_follow_up | date | drives the follow-up task; index |
| notes | text | |
| enquiry_id | int, nullable | **plain column, no foreign key**: `contact_enquiries` was never built (1D parked) |
| enrichment_status | text | default Pending; not driven by research (research status lives on the company) |
| converted_to | text, nullable | `client` when Won |
| do_not_email | bool | default false; the Mailer skips the lead (release 2C) |
| archived_at | timestamp | |
| created_by_id | FK users, nullable | |
| created_at, updated_at | timestamp | `created_at` indexed |

### lead_activities
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads | cascade delete; index (`lead_id`, `occurred_at`) |
| activity_type | text | call / email / meeting / note / research / status / assign / transfer / ai / created / quote |
| title | text | |
| body | text | |
| url | text | |
| status_from, status_to | text | for status changes |
| related_type, related_id | text / int | e.g. `email_message`, a task, a quotation |
| by_user_id | FK users, nullable | null = system |
| occurred_at | timestamp | |

An `email` activity shows its subject only to its sender; everyone else sees "Email sent" (privacy rule, release 2B).

### lead_assignments
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads | cascade delete; index (`lead_id`, `assigned_at`) |
| from_user_id | FK users, nullable | |
| to_user_id | FK users, nullable | null = unassigned |
| by_user_id | FK users, nullable | null = allocation rule |
| rule_id | FK allocation_rules, nullable | |
| note | text | required on manual transfer |
| assigned_at | timestamp | |

### tasks
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads, nullable | cascade delete |
| quotation_id | FK quotations, nullable | set null; index |
| title | text | |
| due_date | date | |
| kind | text | followup / call / meeting, default followup (release 3C) |
| due_time | varchar(5) | `HH:MM` wall-clock time as entered; required for call and meeting |
| duration_minutes | int | call 30, meeting 60; null for a follow-up |
| assigned_to_id | FK users | required; restrict delete |
| is_done, done_at | bool, timestamp | |
| origin | text | follow_up / new_assignment / transfer / manual / quotation |
| closed_reason | text | set when closing a lead closes the task |
| created_at, updated_at | timestamp | |

Indexes: (`assigned_to_id`, `is_done`, `due_date`), (`lead_id`, `origin`, `is_done`), `quotation_id`. Calls and
meetings planned in the CRM are tasks; nothing is written to Outlook.

## Module 3 — Contact Us (not built)

Release 1D (public contact form, `contact_enquiries`, Enquiries screen with the Needs-review queue) is **parked by the
owner** (22 Nov 2026). No table exists. The planned shape, kept for when it is picked up:

### contact_enquiries (planned, immutable)
id PK; full_name, business_email, phone, company_name, company_website, message (as submitted, never edited);
submitted_at; source_page, ip_hash, user_agent; spam_check (Passed / Failed + reason); processing_status (Received /
Needs review / Enrichment pending / Enrichment processing / Processed / Spam); company_id, contact_id, lead_id (FK,
nullable, filled by the workflow); review_candidates json; processing_trace json. A trigger rejects UPDATE on the
submitted columns. `leads.enquiry_id` then gets its foreign key.

## Module 4 — Email

### email_accounts
One `system` row (the CRM's notification mailbox) and at most one `personal` row per user.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| user_id | FK users, nullable | set null |
| address | text | unique with `kind` (the same address may be both the system and a personal mailbox) |
| send_as | text, nullable | system mailbox: a shared mailbox the connecting user has Send-As on; null = `address` |
| provider | text | `microsoft` (Microsoft 365 through Graph; the only provider built) |
| kind | text | `system` / `personal` |
| refresh_token_enc | text | AES-256-GCM with `TOKEN_ENCRYPTION_KEY`; never returned by the API |
| token_expires_at | timestamp | |
| status | text | connected / error / disconnected |
| last_error | text | e.g. `token_unreadable` |
| sync_mail | bool | default true |
| sync_calendar | bool | default false |
| shared_mailboxes | text[] | stored from the Options dialog; not synced yet |
| last_sync_at | timestamp | |
| message_count | int | |
| sync_state | jsonb | mail sync: per folder the Graph next or delta link (release 2B-2) |
| calendar_sync_state | jsonb, nullable | calendar sync: `{ link, userId, full?, at }` (release 3C) |
| calendar_sync_at | timestamp | last full calendar restart (daily) |
| created_at, updated_at | timestamp | |

Planned but not built: display name, tenant / external user id columns (Graph `/me` is read at connect), stored access
tokens (access tokens are cached in memory only), scopes, Graph change-notification subscriptions (sync polls with
delta queries every 5 minutes instead), IMAP / SMTP and Gmail columns.

### email_messages
A user's own mail, private to `user_id`. Lead mail only (web-mail release 1): Administrators and Managers (right
`view_team_mail`) read other users' lead mail, view only.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| user_id | FK users | cascade delete |
| account_id | FK email_accounts, nullable | set null |
| lead_id, contact_id, company_id | FK, nullable | set null; auto-linked by sync matching, or by hand |
| folder | text | sent / inbox / drafts / archive / deleted |
| status | text | CRM-sent: queued / sending / sent / failed; synced: received / sent / draft |
| source | text | `crm` written in the CRM, `sync` read from the mailbox |
| from_address | text | |
| from_name | varchar(255) | |
| to_addresses, cc_addresses, bcc_addresses | jsonb arrays | |
| campaign_id | FK email_campaigns, nullable | the Mailer campaign that sent it |
| project_id | FK projects, nullable | project tag set when sent (release 3B); never widens who sees the message |
| subject | varchar(500) | |
| body_text | text | plain text only (synced bodies kept to 50,000 characters); no HTML body |
| graph_id | varchar(255) | Graph immutable id; unique with `user_id` |
| message_id, thread_id | varchar(255) | RFC message id and Graph conversation id |
| is_read | bool | |
| occurred_at | timestamp | |
| attachment_names | jsonb array | names only; attachments are not downloaded |
| reply_to_id | FK email_messages, nullable | the message this one answers |
| logged_at | timestamp | when it was logged on the lead ("Log as activity") |
| last_error | text | |
| lead_deleted_at | timestamp, nullable | set when the lead, contact or company it was linked to is deleted: kept with its owner, unlinked, never cleaned up as unrelated mail (web-mail release 1) |
| created_at, updated_at | timestamp | |

Indexes: unique (`user_id`, `graph_id`); (`user_id`, `thread_id`), (`user_id`, `lead_id`), (`user_id`, `folder`,
`occurred_at`), (`user_id`, `project_id`). There is no `quotation_id`: a quotation's sent email is found through
`quotations.sending_message_id` while sending, and the timeline.

### mail_backfills (web-mail release 1)
One 12-month mailbox search per mailbox × lead/contact address, resumable.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| account_id | FK email_accounts | cascade delete |
| address | varchar(320) | lower-cased; unique with `account_id` |
| status | text | queued (default) / running / done / failed / skipped |
| next_link | text, nullable | Graph next link to continue from |
| found, stored | int | messages found / stored so far (default 0) |
| attempts | int | default 0 |
| last_error | text, nullable | |
| finished_at | timestamp, nullable | |
| created_at, updated_at | timestamp | |

Indexes: unique (`account_id`, `address`); (`status`, `id`).

### mail_backfill_addresses (web-mail release 1)
Lead/contact addresses already queued for backfill, so each is queued once: `address` varchar(320) PK (lower-cased),
`first_seen_at` timestamp (default now).

### email_templates
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| name | varchar(150) | |
| language | char(2) | en / es / fr |
| subject | varchar(500) | merge fields `{first_name}`, `{company}`, `{me}`, `{lead_id}`, `{quote_no}` |
| body | text | plain text, written in the CRM or read from an uploaded `.oft` / `.msg` |
| body_html | text, nullable | formatted template: the HTML of the `.oft` (or written in the formatted editor), sanitised by the server on save; null = plain text |
| source_type | text | manual / oft |
| file_name, file_size | varchar(255), int | of the uploaded file; **the file itself is not kept** |
| created_by | FK users, nullable | |
| created_at, updated_at | timestamp | |

### email_campaigns (Mailer, release 2C)
| Column | Type | Notes |
|---|---|---|
| id | PK (int) | shown as `MC-001` (id padded) |
| name | varchar(160) | |
| template_id | FK email_templates, nullable | set null |
| template_name | varchar(150) | |
| template_updated_at | timestamp | which version of the template was used |
| language | varchar(5) | the template's language at queueing (for the opt-out line); default en |
| subject, body | varchar(500), text | copy of the template as queued |
| body_html | text, nullable | copy of the template's sanitised HTML as queued (formatted templates go out as HTML) |
| sender_id | FK users | cascade delete |
| account_id | FK email_accounts, nullable | |
| sender_address | text | mailbox used |
| cc, bcc | text[] | applied to every email |
| start_at | timestamp, nullable | null = start immediately |
| interval_minutes | int | spacing between emails (1–15) |
| working_hours_only | bool | Mon–Fri 09:00–18:00 in the **recipient's** time zone |
| unsubscribe_line | bool | default true |
| lawful_basis | varchar(160) | required |
| status | text | Scheduled / Sending / Paused / Completed / Cancelled |
| pause_reason | text | while Paused ("Paused by …", "Mailbox disconnected", …) |
| wait_reason | text | while Sending: working_hours / daily_limit |
| next_send_at | timestamp | index (`status`, `next_send_at`) |
| created_at, completed_at, updated_at | timestamp | |
| cancelled_by_id | int, nullable | |

### email_campaign_recipients
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| campaign_id | FK email_campaigns | cascade delete; index (`campaign_id`, `status`, `position`) |
| lead_id | FK leads, nullable | set null; index |
| contact_id | FK contacts, nullable | |
| to_address | text | |
| name, company | text | as queued |
| timezones | text[] | zones used for working hours |
| timezone_source | text | company / address / country / sender |
| status | text | Queued / Sending / Sent / Failed / Skipped ("Replied" is derived, not stored) |
| position | int | send order |
| sent_at | timestamp | |
| email_message_id | FK email_messages, nullable | the filed sent email |
| error | text | skip or failure reason |

Daily limit: 200 Mailer emails per mailbox per sender's calendar day (code constant, not a column).

## Module 5 — Calendar

Built differently from the plan: calls and meetings planned in the CRM are **tasks** (`tasks.kind`, `due_time`,
`duration_minutes`); `calendar_events` is a private, read-only copy of each user's own Outlook calendar. Nothing is
written to Outlook. Not built: `calendar_event_attendees`, `calendar_connections`, reminders, event types.

### calendar_events
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| user_id | FK users | cascade delete; private to this user, administrators included |
| account_id | FK email_accounts | cascade delete; index |
| graph_id | text | Graph immutable id; unique with `user_id` |
| subject | varchar(500) | |
| starts_at, ends_at | timestamp (UTC) | index (`user_id`, `starts_at`); all-day events run midnight to midnight UTC |
| is_all_day | bool | |
| location | varchar(500) | |
| organizer_name | varchar(255) | |
| organizer_address | varchar(320) | |
| attendee_addresses | jsonb array | lower-cased, organiser excluded |
| is_online | bool | |
| lead_id | FK leads, nullable | an attendee's open lead the user could see when synced |
| company_id | FK companies, nullable | |
| created_at, updated_at | timestamp | |

Rows are deleted when Sync calendar is switched off or the mailbox disconnected.

## Module 6 — Quotations and Projects

### quotations
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| number | varchar(20) | `Q-YYYY-NNN`, **unique**, sequential per calendar year of the quotation date (advisory lock per year, in the API) |
| company_id | FK companies | restrict delete; index |
| contact_id | FK contacts, nullable | |
| lead_id | FK leads, nullable | index |
| owner_id | FK users | restrict delete; index |
| quotation_date | date | index |
| valid_until | date, nullable | |
| currency | varchar(3) | USD / CAD / INR |
| subject | varchar(300) | |
| tax_rate | decimal(5,2) | GST %, one line |
| overall_discount | decimal(5,2) | % |
| notes | text | notes / terms |
| status | varchar(20) | Draft / Sent / Negotiating / Accepted / Rejected / Expired, default Draft; index |
| revision | int | the revision being worked on |
| editing_new_revision | bool | a sent quotation was edited: `revision` is the unsent n+1 |
| sending_message_id | FK email_messages, nullable | the queued email while the quotation shows "Sending…" |
| project_id | FK projects, nullable | the project made from or linked to it; index |
| history | jsonb | `[ { at, text } ]`, oldest first |
| created_at, updated_at | timestamp | |

### quotation_lines
The working copy's lines (they belong to the quotation, not to a revision).

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| quotation_id | FK quotations | cascade delete; index (`quotation_id`, `sort_order`) |
| sort_order | int | |
| item | varchar(300) | |
| description | text | |
| qty | decimal(12,2) | |
| unit | varchar(30) | |
| unit_price | decimal(14,2) | |
| discount | decimal(5,2) | line discount % |

No `line_total` column: totals are computed.

### quotation_revisions
A sent revision, frozen when the send succeeds. A re-send without edits adds no row.

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| quotation_id | FK quotations | cascade delete; unique with `revision_no` |
| revision_no | int | |
| sent_at | timestamp | |
| sent_to | varchar(320) | the contact address |
| subtotal, discount_total, tax_total, grand_total | decimal(14,2) | |
| note | text | |
| snapshot | jsonb | header + lines + totals + company / contact display fields, as printed |
| created_at | timestamp | |

No `pdf_path`: the PDF is drawn again from the snapshot on demand (pdfkit, server-side).

### company_settings
Settings → Company details (Administrators). Single row (`id` = 1, CHECK in the migration SQL), seeded with the issuer
(DAIT Partners LLP, Delhi).

| Column | Type | Notes |
|---|---|---|
| id | int PK | always 1 |
| legal_name | varchar(200) | |
| address_lines | jsonb array | printed one per line |
| email | varchar(255) | |
| gstin | varchar(15), nullable | printed only on INR quotations, when set |
| tax_inr, tax_usd, tax_cad | decimal(5,2) | default GST per currency: 18 / 0 / 0 |
| default_notes | text | |
| updated_at | timestamp | |

### price_list_items (not built)
Not in the prototype UI; not built.

### projects
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| number | varchar(20) | `PRJ-<n>`, **unique**, sequential (advisory lock, in the API) |
| company_id | FK companies | the client; restrict delete; index |
| lead_id | FK leads, nullable | the lead it came from; index |
| quotation_id | FK quotations, nullable | **unique** (one project per quotation); `quotations.project_id` points back |
| name | varchar(200) | |
| status | varchar(20) | Active / On hold / Completed / Cancelled, default Active; index |
| start_date | date | |
| value | decimal(14,2), nullable | from a quotation: net before GST |
| currency | varchar(3) | USD / CAD / INR |
| manager_id | FK users | restrict delete; index |
| description | text | |
| created_by_id | FK users | |
| completed_at | timestamp | set when status becomes Completed |
| created_at, updated_at | timestamp | |

### project_stakeholders
Primary stakeholders (every row is one), copied (Cc) on every email sent with the project selected.
Composite PK (`project_id`, `contact_id`); both cascade delete; index `contact_id`. No `role` / `is_primary` columns.

## Shared / configuration

### users
id PK; email (unique); name; role (enum `role`: ADMINISTRATOR / MANAGER / SALES_REPRESENTATIVE / DATA_RESEARCH_USER);
language (default `en`; en / es / fr); timezone (default `Europe/London`); date_format (default `DD MMM YYYY`);
is_active; microsoft_oid (unique, set at first Microsoft sign-in); last_login_at; password_hash (argon2id, local
administrators only); is_local_admin; created_at, updated_at.

### sessions
id (random text PK, the cookie value); user_id FK (cascade); expires_at (index); created_at; last_seen_at.

### lookup_values
id PK; group; value (unique with group); label; label_es; label_fr; sort_order; is_active. Groups seeded on every
deploy: lead_source, lead_status, lead_type, priority, industry, business_category, business_type, employee_range,
revenue_range, ownership_type, contact_type, location_type, country, currency, quote_status. Administrators add values
in Settings; forms read them.

### allocation_rules
id PK; name; match_countries (jsonb: country list or `["*"]`); match_language (char(2), nullable = any); assign_to
(jsonb user-id list, round robin); round_robin_pos; priority; is_active.

### jobs
Background job queue for the worker (PostgreSQL, `FOR UPDATE SKIP LOCKED`; no Redis). id PK; type (send_email,
send_user_email, sync_mailbox, mail_action, campaign_step, sync_calendar, research_company); payload jsonb; run_at;
attempts; max_attempts (default 8); status (queued / running / done / failed); last_error; locked_at; created_at,
updated_at. Index (`status`, `run_at`). Done jobs are deleted after 7 days, failed after 30.

### notifications
id PK; user_id FK (cascade); text; detail; link; is_read; created_at. Index (`user_id`, `is_read`). In-app only.

### audit_logs
id PK; entity_type; entity_id (text); action; user_id FK (nullable); before jsonb; after jsonb; at. Index
(`entity_type`, `entity_id`). A lead `delete` row keeps only the lead's and its contact's addresses in `before`
(`{ emails: [...] }`, lower-cased), so web-mail clean-up can recognise mail of a deleted lead; action `view` records
an Administrator or Manager opening another user's message.

Planned but not built: `password_resets` (no password sign-in except the break-glass admin), `updated_by` columns.

## Relationships

```
companies 1─n contacts            companies 1─n company_locations      companies 1─n leads
contacts  1─n leads               companies 1─n enrichment_runs 1─n enrichment_suggestions
companies 1─n source_records      leads 1─n lead_activities / lead_assignments / tasks
companies 1─n quotations          leads 1─n quotations                 quotations 1─n quotation_lines
quotations 1─n quotation_revisions                                     quotations 1─n tasks
quotations 1─1 projects (projects.quotation_id unique; quotations.project_id back)
companies 1─n projects            leads 1─n projects                   projects n─n contacts (project_stakeholders)
users 1─n email_accounts 1─n email_messages     email_messages n─1 leads / contacts / companies / projects
email_accounts 1─n mail_backfills
email_templates 1─n email_campaigns 1─n email_campaign_recipients     email_campaigns 1─n email_messages
users 1─n calendar_events         email_accounts 1─n calendar_events   calendar_events n─1 leads / companies
users ← assigned_to / owner / manager / created_by / by_user / decided_by on the tables above
```

## Indexes that matter

- `companies(domain)` unique, `companies(name_normalised, country)`, `companies(registration_number)`
- `contacts(business_email)`, `contacts(phone_normalised)`, `contacts(mobile_normalised)`, one primary per company
- `leads(status)`, `leads(assigned_to_id)`, `leads(company_id)`, `leads(created_at)`, `leads(next_follow_up)`,
  `leads(lead_type)`, `leads(country)`
- `tasks(assigned_to_id, is_done, due_date)`
- `email_messages(user_id, graph_id)` unique, `(user_id, thread_id)`, `(user_id, folder, occurred_at)`
- `calendar_events(user_id, starts_at)`, `quotations(status)`, `jobs(status, run_at)`
