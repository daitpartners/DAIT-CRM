# DAIT Partners CRM — Data model (column level)

One shared relational database, extended by migrations. Tables marked **existing** are already in the CRM and are
extended, never recreated. Follow the CRM's current ID strategy (UUID or auto-increment); IDs below are shown as `id PK`.
Every FK gets an index. `created_at`, `updated_at`, `created_by`, `updated_by` exist on every new table and are omitted below.

## Module 2 — Company Management

### companies
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| name | varchar(200) | required |
| legal_name | varchar(200) | |
| website | varchar(255) | |
| domain | varchar(150) | normalised from website / business email; **unique index**; first duplicate-check key |
| industry | varchar(100) | lookup_values group `industry` |
| business_category | varchar(100) | lookup |
| business_type | varchar(60) | lookup |
| year_established | smallint | |
| description | text | |
| logo_path | varchar(255) | upload |
| linkedin_url | varchar(255) | |
| status | enum Active / Inactive / Closed | |
| is_client | bool | set when a lead is Won or a quotation accepted |
| country, state, city, street, zip | varchar | HQ address |
| timezone | varchar(60) | |
| lat, lng | decimal(9,6) | |
| maps_url | varchar(255) | Google Maps / Places |
| employee_count | int | |
| employee_range | varchar(20) | lookup |
| annual_revenue | decimal(18,2) | |
| revenue_currency | char(3) | |
| revenue_range | varchar(20) | lookup |
| ownership_type | varchar(60) | lookup |
| registration_number | varchar(60) | index |
| stock_exchange, stock_symbol | varchar | |
| main_products, main_services | text | |
| business_verticals, target_markets, geographic_markets | json array | multi-select |
| key_brands | varchar(255) | |
| specialisation | text | |
| social_facebook, social_instagram, social_x, social_youtube, social_other | varchar(255) | |
| website_technology | varchar(255) | |
| website_assessment, digital_summary | text | AI-generated |
| ai_summary | text | AI |
| ai_industry, ai_business_category | varchar(100) | AI |
| ai_potential_services | json array | AI |
| ai_opportunity_score | tinyint 0–100 | AI |
| ai_confidence | enum High / Medium / Low | AI |
| ai_research_status | enum Pending / Processing / Completed / Failed | |
| ai_last_research_at | datetime | |
| verification_status | enum Verified / Partially Verified / Unverified | computed |
| verified_fields | json | `{ "industry": true, ... }` — fields a user confirmed; AI never overwrites these |
| ai_fields | json | fields currently holding an accepted AI value, with confidence and source |

### contacts
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | index |
| first_name, last_name | varchar(100) | |
| designation, department | varchar(100) | |
| business_email | varchar(255) | index; first contact-match key |
| phone, mobile | varchar(40) | stored raw; matched on normalised digits (`phone_normalised` indexed column) |
| linkedin_url | varchar(255) | |
| contact_type | enum Decision Maker / Influencer / Other | |
| is_primary | bool | one per company |
| is_active | bool | default true (release 1C) |
| headline, location | varchar(200) | profile header (prototype lead page) |
| about | text | |
| experience | json array | `[ { title, company, from, to, description } ]` |
| education | json array | `[ { school, degree, from, to } ]` |
| skills, languages | json array of strings | |

### company_locations
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | |
| name | varchar(120) | |
| location_type | enum Headquarters / Branch / Warehouse / Registered office / Factory | lookup |
| country, state, city, street, zip, timezone | varchar | |
| lat, lng | decimal(9,6) | |
| maps_url, phone | varchar | |
| is_verified | bool | |
| source | varchar(120) | e.g. "Google Places", "Manual" |

### enrichment_history
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | |
| lead_id | FK leads, nullable | the lead that triggered the run |
| triggered_by | varchar(120) | "New lead LD-…", "Manual · user" |
| engine | varchar(80) | "ollama:llama3.1:8b", "claude:…" |
| sources_used | json array | website, places, apollo, websearch |
| suggestions | json | `[ { field, value, confidence, source, decision, decided_by, decided_at } ]` |
| applied_count | int | |
| status | enum Pending / Processing / Completed / Failed | |
| error | text | |
| started_at, finished_at | datetime | |

### source_records
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | |
| lead_id | FK leads, nullable | for research notes saved on a lead |
| title | varchar(200) | |
| url | varchar(500) | |
| source_type | enum Company website / Google Places API / Public registry / Business directory / Social profile / Contact form / Manual research / CSV import | |
| collected_at | datetime | |
| collected_by | varchar(120) | worker or user |
| fields_populated | varchar(500) | |
| confidence | varchar(20) | |
| snapshot | mediumtext | raw extract, read-only |

## Module 1 — Lead Management

### leads (existing — extend)
| Column | Type | Notes |
|---|---|---|
| id | PK | existing Lead ID format kept |
| lead_type | enum Lead / Prospect | **new** |
| company_name | varchar(200) | required |
| company_id | FK companies | **new**; nullable only until duplicate check resolves |
| contact_id | FK contacts | **new**, nullable (prospects) |
| website, business_email, phone | varchar | |
| country | varchar(80) | required |
| city | varchar(100) | |
| lead_source | varchar(60) | lookup `lead_source` |
| source_url | varchar(500) | |
| import_batch | varchar(40) | CSV / Places batch id |
| assigned_to | FK users | existing |
| priority | enum High / Medium / Low | default Medium |
| status | varchar(40) | lookup `lead_status`, default New |
| next_follow_up | date | drives tasks |
| notes | text | |
| enquiry_id | FK contact_enquiries | **new** |
| enrichment_status | enum Pending / Processing / Completed / Failed | **new** |
| converted_to | enum client / project, nullable | |
| archived_at | datetime | |

### lead_activities (existing activity notes — extend)
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads | index |
| activity_type | enum call / email / meeting / note / research / status / assign / transfer / ai / created / quote | |
| title | varchar(200) | |
| body | text | |
| url | varchar(500) | research links |
| status_from, status_to | varchar(40) | for status changes |
| related_type, related_id | varchar / id | email_message, calendar_event, quotation |
| by_user | FK users, nullable | null = system |
| occurred_at | datetime | |

### lead_assignments (existing transfer history — extend)
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads | |
| from_user | FK users, nullable | |
| to_user | FK users | |
| by_user | FK users, nullable | null = allocation rule |
| rule_id | FK allocation_rules, nullable | |
| note | text | required on manual transfer |
| assigned_at | datetime | |

### tasks (existing — extend)
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| lead_id | FK leads, nullable | **new** |
| quotation_id | FK quotations, nullable | |
| title | varchar(200) | |
| due_date | date | index |
| assigned_to | FK users | |
| is_done, done_at | bool, datetime | |
| origin | enum follow-up date / new assignment / transfer / manual / quotation | |

## Module 3 — Contact Us

### contact_enquiries (immutable)
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| full_name | varchar(150) | as submitted |
| business_email | varchar(255) | as submitted |
| phone | varchar(40) | |
| company_name | varchar(200) | as submitted |
| company_website | varchar(255) | |
| message | text | as submitted; never edited |
| submitted_at | datetime | |
| source_page, ip_hash, user_agent | varchar | |
| spam_check | enum Passed / Failed, + reason | |
| processing_status | enum Received / Needs review / Enrichment pending / Enrichment processing / Processed / Spam | |
| company_id, contact_id, lead_id | FK, nullable | filled by the workflow; never changes the submitted columns |
| review_candidates | json | company ids offered for manual review |
| processing_trace | json | step log |

Application rule: UPDATE on the submitted columns is refused (trigger or model guard); only `processing_*` and FK columns change.

## Module 4 — Email

### email_accounts
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| user_id | FK users | |
| address | varchar(255) | |
| provider | enum microsoft_graph / gmail_api / imap_smtp | Microsoft 365 Business Basic connects via microsoft_graph |
| display_name | varchar(150) | |
| tenant_id, external_user_id | varchar | Microsoft tenant and Graph user id (or Google account id) |
| refresh_token | text, encrypted (AES-256) | never returned by the API |
| access_token, token_expires_at | text encrypted, datetime | refreshed server-side |
| scopes | json array | Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, User.Read, offline_access |
| sync_mail, sync_calendar | bool | user options |
| shared_mailboxes | json array | addresses included with delegated access |
| mail_delta_link, calendar_delta_link | text | Graph delta tokens |
| mail_subscription_id, subscription_expires_at | varchar, datetime | Graph change-notification subscription |
| imap_host, smtp_host, username | varchar | IMAP/SMTP only |
| status | enum connected / needs_reauth / disconnected | |
| connected_at, last_sync_at, last_error | datetime, text | |

### email_messages
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| account_id | FK email_accounts | |
| message_id | varchar(255) | RFC message id; unique with account |
| thread_id | varchar(255) | index |
| folder | enum inbox / sent / drafts / archive | |
| from_address, to_addresses, cc_addresses | varchar / json | |
| subject | varchar(500) | |
| body_text, body_html | mediumtext | |
| received_at | datetime | index |
| is_read | bool | |
| lead_id, contact_id, company_id, quotation_id, project_id | FK, nullable | auto-linked on sender address; manual link allowed; project set from the compose context |
| cc_addresses | json | stakeholders copied |
| attachments | json | paths |

### email_templates
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| name | varchar(150) | |
| language | char(2) | en / es / fr; user's language listed first |
| subject | varchar(500) | with merge fields |
| body_text, body_html | text | parsed from .oft or written in the CRM |
| source_type | enum manual / oft | |
| file_path, file_name, file_size | varchar, int | original uploaded .oft kept on disk |
| merge_fields | json array | detected placeholders |
| created_by | FK users | |

## Module 5 — Calendar

### calendar_events
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| title | varchar(200) | |
| event_type | enum meeting / call / appointment / follow-up / internal | |
| starts_at, ends_at | datetime | index on starts_at |
| timezone | varchar(60) | |
| location | varchar(255) | |
| organiser_id | FK users | |
| lead_id, company_id, contact_id | FK, nullable | |
| reminder_minutes | int | |
| external_provider, external_id | varchar | future Outlook / Google sync |
| notes | text | |

### calendar_event_attendees
id PK, event_id FK, user_id FK nullable, contact_id FK nullable, response enum (invited / accepted / declined), notified_at.

### calendar_connections (future)
id PK, user_id FK, provider, credentials (encrypted), last_sync_at.

## Module 6 — Quotations

### quotations
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| number | varchar(20) | `Q-YYYY-NNN`, unique, sequential per year |
| company_id | FK companies | |
| contact_id | FK contacts | |
| lead_id | FK leads | |
| owner_id | FK users | |
| quotation_date, valid_until | date | |
| currency | char(3) | |
| subject | varchar(300) | |
| tax_rate, overall_discount_pct | decimal(5,2) | |
| notes_terms | text | |
| status | enum Draft / Sent / Negotiating / Accepted / Rejected / Expired | lookup |
| current_revision | int | |
| project_id | FK projects, nullable | set on conversion |

### quotation_revisions
id PK, quotation_id FK, revision_no, subtotal, discount_total, tax_total, grand_total, pdf_path, sent_at, sent_to, note, snapshot_json (frozen copy of header + lines).

### quotation_lines
id PK, revision_id FK, sort_order, item, description, quantity decimal(12,2), unit varchar(30), unit_price decimal(14,2), discount_pct decimal(5,2), line_total decimal(14,2).

### price_list_items
id PK, name, description, unit, default_price, currency, is_active.

### projects (existing client/project record — extend)
| Column | Type | Notes |
|---|---|---|
| id | PK | |
| company_id | FK companies | the client |
| lead_id | FK leads | the lead this project came from; many projects per company |
| quotation_id | FK quotations, nullable | |
| name | varchar(200) | |
| status | enum Active / On hold / Completed / Cancelled | |
| start_date | date | |
| value, currency | decimal(14,2), char(3) | |
| manager_id | FK users | |
| description | text | |

### project_stakeholders
id PK, project_id FK, contact_id FK, role (primary / member), is_primary bool. Primary stakeholders are pre-filled in Cc on every email composed with the project selected.

## Shared / configuration

### users (existing) — id, name, email, role (Administrator / Manager / Sales Representative / Data Research User), **language** char(2) default `en` (new), timezone.
### lookup_values — id PK, group (lead_source, lead_status, industry, business_category, employee_range, revenue_range, ownership_type, contact_type, location_type, quote_status), value, label, sort_order, is_active. Administrators add values here; forms read them.
### allocation_rules — id PK, name, match_country (json array or `*`), assign_to (user id or json list for round-robin), priority, is_active.
### notifications (existing) — id PK, user_id FK, text, detail, link, is_read, created_at.
### audit_log — id PK, entity_type, entity_id, action (create / update / delete / merge / verify), user_id FK, before_json, after_json, at.

## Relationships

```
companies 1─n contacts            companies 1─n company_locations
companies 1─n leads               contacts  1─n leads
companies 1─n enrichment_history  companies 1─n source_records
contact_enquiries 1─1 leads (lead_id)   contact_enquiries n─1 companies, contacts
leads 1─n lead_activities         leads 1─n lead_assignments        leads 1─n tasks
leads 1─n quotations              quotations 1─n quotation_revisions 1─n quotation_lines
quotations 1─1 projects           leads 1─n email_messages          leads 1─n calendar_events
calendar_events 1─n calendar_event_attendees      email_accounts 1─n email_messages
users ← assigned_to / owner_id / organiser_id / by_user on the tables above
```

## Indexes that matter

- `companies(domain)` unique, `companies(registration_number)`, `companies(lower(legal_name))`
- `contacts(lower(business_email))`, `contacts(phone_normalised)`, `contacts(company_id)`
- `leads(status)`, `leads(assigned_to)`, `leads(company_id)`, `leads(created_at)`, `leads(next_follow_up)`
- `tasks(assigned_to, due_date, is_done)`
- `email_messages(thread_id)`, `email_messages(lead_id)`, `calendar_events(starts_at)`, `quotations(status)`

## Mailer (added with the mailer module)

The prototype keeps recipients inside each campaign record; the real build uses two tables.

### email_campaigns

| Column | Type | Notes |
|---|---|---|
| id | varchar(12) PK | e.g. MC-001 |
| name | varchar(160) | |
| template_id | FK email_templates | |
| template_name, template_version | varchar / datetime | which template and which version of it was used |
| subject, body | varchar(255) / text | copy of the template as queued, so later edits do not change the record |
| sender_user_id | FK users | must have a connected mailbox |
| sender_address | varchar(255) | mailbox used |
| cc, bcc | text | comma-separated, applied to every email |
| start_at | datetime NULL | NULL = start immediately |
| interval_seconds | int | spacing between emails (the prototype stores minutes) |
| working_hours_only | boolean | 09:00–18:00 office time |
| unsubscribe_line | boolean | |
| lawful_basis | varchar(160) | required |
| status | enum | Scheduled, Sending, Paused, Completed, Cancelled |
| created_by, created_at, completed_at | FK users / datetime | |

### email_campaign_recipients

| Column | Type | Notes |
|---|---|---|
| id | bigint PK | |
| campaign_id | FK email_campaigns | index |
| lead_id | FK leads | index |
| contact_id | FK contacts NULL | |
| to_address | varchar(255) | unique per campaign |
| status | enum | Queued, Sent, Failed, Skipped (Replied is derived from a later inbound email on the lead) |
| sent_at | datetime NULL | |
| message_id | varchar(255) NULL | Graph message id; links to the filed email |
| error | varchar(255) NULL | skip or failure reason |

### Additions to existing tables

| Table | Column | Notes |
|---|---|---|
| leads | do_not_email boolean | blocks the mailer |
| contacts | unsubscribed_at datetime NULL | set with do_not_email |
| emails | bcc text, campaign_id FK NULL | which campaign sent it |
