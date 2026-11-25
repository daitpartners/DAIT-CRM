# Database migrations

Every folder in `prisma/migrations`, in the order `prisma migrate deploy` applies them. `deploy/release.sh` runs
`migrate deploy` on every install, before the new release is switched on, so a deploy applies whatever is new. There are
no down-migrations: a code rollback leaves the schema as it is, which is why each migration only adds (or widens) and the
previous release keeps working against it. Release shas are the commits that were live after that release (see
`docs/PENDING.md`).

| # | Folder | What it changes | Shipped in |
|---|---|---|---|
| 1 | `20261120190014_foundation` | Enum `role`; tables `users`, `sessions`, `lookup_values` (unique group + value), `allocation_rules`, `email_accounts` (address unique), `jobs`, `notifications`, `audit_logs`, with their indexes and foreign keys | 1A (foundation) |
| 2 | `20261120190537_local_admin` | `users.is_local_admin`, `users.password_hash` (break-glass local administrator) | 1A |
| 3 | `20261121120000_email_account_send_as` | `email_accounts.send_as` (system mailbox sends as a shared mailbox) | 1A |
| 4 | `20261122100000_companies_contacts` | Tables `companies`, `contacts`, `company_locations`; sequence `company_number_seq` and function `next_company_number()` (CO-0001 …); unique `companies.domain`; partial unique index `contacts_one_primary_per_company` | 1B |
| 5 | `20261123100000_leads_tasks` | Tables `leads`, `lead_activities`, `lead_assignments`, `tasks` (with a plain `quotation_id` column); sequence `lead_number_seq` and function `next_lead_number()` (LD-1001 …); `contacts.is_active` | 1C |
| 6 | `20261124100000_contact_profile` | `contacts.headline`, `location`, `about`, `experience`, `education`, `skills`, `languages` (lead page profile) | Prototype parity |
| 7 | `20261125100000_release_2a` | `email_accounts` unique key becomes (`address`, `kind`); adds `sync_mail`, `sync_calendar`, `shared_mailboxes`, `last_sync_at`, `message_count`; table `email_templates` | 2A (`7d695e6`) |
| 8 | `20261126100000_outreach_language` | `leads.outreach_language` (default `en`), `allocation_rules.match_language` | Outreach language (`b97aa6c`) |
| 9 | `20261127100000_email_messages` | Table `email_messages` (a user's own mail, private to them) | 2B-1 (`ccfb2b4`) |
| 10 | `20261128100000_mail_sync` | `email_accounts.sync_state`; `email_messages.graph_id` (unique per user), `source`, `from_name`, `attachment_names`, `reply_to_id`, `logged_at`; index (`user_id`, `thread_id`) | 2B-2 (`8b1a8d9`) |
| 11 | `20261129100000_mailer` | Tables `email_campaigns`, `email_campaign_recipients`; `leads.do_not_email`; `contacts.unsubscribed_at`; `email_messages.bcc_addresses`, `campaign_id` | 2C Mailer (`4bb3601`) |
| 12 | `20261130100000_campaign_language` | `email_campaigns.language`, back-filled from each campaign's template | Mail follow-ups (`2d4e618`) |
| 13 | `20261201100000_task_kind_time` | `tasks.kind` (default `followup`), `due_time`, `duration_minutes` (calls and meetings as timed tasks) | 3C Calendar (`efaf872`) |
| 14 | `20261201110000_calendar_events` | Table `calendar_events` (private copy of each user's Outlook calendar); `email_accounts.calendar_sync_at`, `calendar_sync_state` | 3C Calendar (`efaf872`) |
| 15 | `20261202100000_quotations` | Tables `quotations` (with a plain `project_id`), `quotation_lines`, `quotation_revisions`, `company_settings` (single row, CHECK id = 1, seeded with the issuer); foreign key `tasks.quotation_id` → `quotations` | 3A Quotations (`436dc98`) |
| 16 | `20261203100000_projects` | Tables `projects`, `project_stakeholders`; `email_messages.project_id`; clears any stray `quotations.project_id` and adds its foreign key | 3B Projects (`2c14c1c`) |
| 17 | `20261204100000_ai_research` | Tables `enrichment_runs`, `enrichment_suggestions`, `source_records`, `enrichment_settings` (single row, CHECK id = 1, seeded); `companies.ai_research_status` default becomes `Not started` and never-researched companies are back-filled to it | 4 AI research (`fa12206`) |
| 18 | `20261205100000_claude_code_run_cap` | `enrichment_settings.claude_monthly_run_cap` (default 0 = Claude off) | Claude Code engine (`08ee5da`) |
| 19 | `20261206100000_email_body_html` | `email_messages.body_html` (nullable: the sanitised HTML body; older rows filled when first opened) | Email reader HTML (not yet released) |
| 20 | `20261206100000_import_leads` | Tables `import_batches`, `import_files`, `import_rows` (Import leads + Data manager) | Import leads (not yet released) |
| 21 | `20261207100000_company_name_normalise` | Function `normalise_company_name(text)` (the SQL twin of shared `normaliseCompanyName`: accents folded, es/fr legal forms removed); back-fills `companies.name_normalised` with it (derived key only; `updated_at` untouched) | Import leads (not yet released) |
| 22 | `20261208100000_template_body_html` | `email_templates.body_html` and `email_campaigns.body_html` (nullable: a formatted template's sanitised HTML, and the copy a Mailer campaign keeps when queued; null = plain text as before) | Formatted templates (not yet released) |
| 23 | `20261209100000_template_attachments` | Table `email_template_attachments` (a template's inline pictures and attachments read from its .oft: file name, type from the bytes, size, content-id, inline flag, sha256, storage path under STORAGE_DIR/templates/; cascade-deleted with the template) and `email_campaigns.attachments` (JSONB, default `[]`: the campaign's copies under STORAGE_DIR/campaigns/) | Template pictures and attachments (not yet released) |
| 24 | `20261210100000_import_row_changes` | `import_rows.changes` (nullable jsonb: what an update row — Lead ID / Company ID from "Download all leads" — filled, for Undo, and the conflicts it did not apply) | Leads export (not yet released) |

## Known leftover

- `enrichment_settings.claude_monthly_cap_usd` is intentionally still in the table. Migration 17 created it for the
  Claude API design; migration 18 replaced it with `claude_monthly_run_cap` but left the old column so the processes still
  running the previous release kept working during the deploy. It is no longer in `prisma/schema.prisma` and nothing
  reads or writes it. Drop it in a later migration:
  `ALTER TABLE "enrichment_settings" DROP COLUMN "claude_monthly_cap_usd";`
- `enrichment_runs.cost_usd` is still in the schema but always 0 (Claude Code runs on a subscription, with no per-call
  price).

## Adding a migration

Change `prisma/schema.prisma`, then `npm run db:migrate -w apps/api -- --name <name>` (`prisma migrate dev`) against a local database, check the generated
SQL, and commit the folder. Keep it backward-compatible (add nullable or defaulted columns; drop columns only one release
after the code stopped using them), because migrations run before the switch and a rollback does not undo them.
