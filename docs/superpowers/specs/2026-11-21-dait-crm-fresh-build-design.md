# DAIT Partners CRM — fresh build design

Date: 21 Nov 2026. Status: draft for Deepak's approval. Owner: Deepak Singh (DAIT Partners).

Companion material in this repository: `docs/DAIT-CRM-Specification-v2.md` (modules, rules), `docs/data-model.md`
(tables and columns), `docs/development-plan.md` (release order, pending decisions), `docs/ux-test-report.md`, the
prototype (`index.html`, `css/app.css`, `js/`, `public/contact.html`; `js/store.js` holds every business rule).
Where this document and those differ, this document wins. Where this document is silent, the specification wins.

## 1. Intent and why

Build the DAIT Partners CRM as a real, multi-user web application and deploy it at https://crm.daitpartners.com on the
company's existing server, replacing the password-protected prototype copy that is there today. The prototype and its
documents were the design phase; this is the build.

**Premise change.** The specification says "enhance the existing Node.js CRM, keep its database". There is no existing
CRM with data: crm.daitpartners.com serves a static prototype. Deepak confirmed on 21 Nov 2026: *"it's a fresh build,
ignore the existing."* Every instruction in the spec and plan about inspecting, preserving or extending existing code,
tables, roles or integrations is therefore void. The spec's Phase 1 (inspect) and the plan's Phase 0 findings report are
dropped. Everything else in the spec stands as requirements.

**Why now.** DAIT Partners' sales team needs one place to hold companies, contacts and leads, capture website enquiries,
work leads to Won and send email from the record, instead of the browser-only prototype.

## 2. Goals, non-goals, anti-goals

**Goals**
- A production CRM at crm.daitpartners.com that looks and behaves like the approved prototype, screen for screen.
- Every business rule in `js/store.js` enforced on the server, with an automated test per rule.
- Data in PostgreSQL; nothing of record lives in the browser.
- Released in the order Deepak chose: (1) Leads and Companies, (2) Email and Mailer, (3) Quotations, Projects and
  Calendar, (4) AI research, (5) handover. Each release is checked by Deepak on a test site before it goes live.
- Fast at 100,000+ leads: lists are filtered, sorted and paged by the database.
- English, Spanish and French per user from release 1.

**Non-goals**
- Reusing the abandoned "Version 1" codebase (`~/Documents/DAIT-CRM/Version 1`). Its server setup notes are reused as
  facts about the server; its code is not imported.
- Mobile apps. The web app must work on a phone (the prototype's H3 defect gets fixed), nothing more.
- Self-hosted AI (Ollama) in release 4. The server has no GPU; release 4 starts with the Claude API behind the provider
  interface, Ollama stays a later option on another machine.
- Importing data from any older system. Release 1 starts with an empty database plus lookup values and users.

**Anti-goals** (failure even if it works)
- A screen that looks different from the prototype without Deepak agreeing to the change.
- A rule that exists only in the browser. If the API accepts it, the rule is not enforced.
- Secrets in the repository, in the public site or in the browser.
- A public contact endpoint that can be used to spam the team or read CRM data.
- Downtime for the other 40+ sites on the shared server. Nothing in this build touches root-owned services.

## 3. Constraints

- **Server:** 88.222.213.73, AlmaLinux 9, CyberPanel, OpenLiteSpeed 1.9.3 in front, shared with other sites. The
  `daitcrm` Linux user already exists with Node 24 (nvm), PM2 as its own systemd service (`pm2-daitcrm`), folders
  `~/live` and `~/test` (releases/current/shared layout), PostgreSQL databases `dait_crm` and `dait_crm_test` with
  one login each. Ports 3090 (live) and 3091 (test) are reserved for the CRM. See the Version 1 notes
  `deploy/server-setup.md` for what was done and how.
- **Root actions on the production server are performed by Deepak** (commands supplied by the builder, run with `!`).
  The builder never pastes secrets into chat or into the repository.
- **Entra app registration** (Microsoft 365 sign-in and Graph mail/calendar) has been pending for weeks. Release 1 must
  not depend on it.
- **Brand:** the prototype's palette, Montserrat and components in `css/app.css` are approved and must be carried over.
- **Design canvas and prototype are the UI reference.** Dropdowns with 8+ options are searchable comboboxes.
- **New npm dependencies** are pinned to versions published at least two weeks before they are added.
- **Private repository.** The repo holds the real prospect data model and later real lookup values; GitHub private only.

## 4. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Keep the prototype's HTML/vanilla JS as the frontend; replace `store.js` with calls to a new Node API | Fastest to the first screen; but the prototype is demo code (no components, phrase-based i18n, browser paging, no tests) and would be reworked twice | Rejected |
| **B** | **Full-stack rebuild: Node/Fastify/Prisma/PostgreSQL API, React/Vite frontend reproducing the prototype's screens and stylesheet, rules ported server-side with tests, separate worker** | Slower to the first screen; it is the thing that gets deployed and grown. The stack already runs on the server | **Chosen by Deepak, 21 Nov 2026** |
| C | Customise an open-source CRM | The spec's rules, brand and workflows are specific enough that bending another product would cost more than it saves | Rejected |

## 5. Decisions already made

**Sign-in (builder's call, offered to Deepak, not contested):** release 1 uses email + password with server-side sessions
(httpOnly cookie), password reset by emailed link, administrator-created users. "Sign in with Microsoft" is added in
release 2 alongside the mailbox connection, once the Entra app exists. A user's Microsoft identity is linked by email
address, so nobody gets a second account.

**Stack (builder's call under approach B):**
- API: Node 24, Fastify 5, Prisma 6 on PostgreSQL 15+ (whatever the server runs; check at setup), Zod for input
  validation, Pino logs. One process serves the API under `/api/*` and the built frontend as static files.
- Worker: a second Node process (same codebase, `apps/worker`) for mailer sends, mail sync, reminders, enrichment and
  scheduled jobs. Job queue in PostgreSQL (a `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED`), no Redis.
- Frontend: React 18, Vite, TypeScript, React Router, TanStack Query for data, react-hook-form + Zod for forms,
  `css/app.css` ported as the global stylesheet with components matching the prototype markup. No UI kit.
- Shared package: types, Zod schemas, rights, picklists helpers, duplicate-normalisation functions (domain, phone, name)
  used by both API and web.
- i18n: `locales/en.json`, `es.json`, `fr.json` keyed by English phrase, as the spec says; lookup values carry
  `label_es`/`label_fr`; dates and numbers via `Intl` with the user's locale and time zone.
- Tests: Vitest for shared and API (against a real test database), Playwright for end-to-end on a seeded database.
  `npm test` runs all three. CI on GitHub Actions runs them on every push.
- Repository: npm workspaces `apps/api`, `apps/worker`, `apps/web`, `packages/shared`, in this repository
  (`~/Documents/DAIT-CRM/CRM-DAIT`, GitHub private). The prototype stays in `prototype/` as the reference and is not served.

**Data model:** `docs/data-model.md` is the schema, with these changes:
- All tables are new (nothing "existing — extend"). IDs are integer primary keys; business numbers (`LD-`, `CO-`, `Q-`,
  `PR-` prefixes as in the prototype) come from PostgreSQL sequences, quotation numbers sequential per year.
- `users` gets `password_hash` (argon2id), `is_active`, `last_login_at`, `timezone`, `language`, `date_format`.
- `sessions`, `password_resets`, `jobs`, `notifications` are added.
- `contact_enquiries` immutability is enforced by a trigger that rejects UPDATE on the submitted columns.
- Optimistic concurrency: every editable record carries `updated_at`; writes send the value they loaded and the API
  rejects a stale write (the plan's "one source of truth" fix).
- Audit log on create/update/delete of every business entity.

**Permissions:** the four roles from the spec. Administrator: everything. Manager: all leads, companies, quotations,
transfers, reports. Sales Representative: own leads (assigned to them) and their companies and contacts; own email,
calendar, quotations. Data Research User: prospects, companies, research records; no quotations or email. A task can be
assigned only to someone who can see its lead (owner or admin/manager). Row visibility is enforced in the API, not the UI.
*Deepak may change who sees what (pending decision 4 below); the mechanism does not change.*

**Hosting and release:**
- Two environments on the same server: **test** `crm-test.daitpartners.com` → port 3091, database `dait_crm_test`;
  **live** `crm.daitpartners.com` → port 3090, database `dait_crm`. OpenLiteSpeed vhost per environment proxies to the
  port; Let's Encrypt via CyberPanel. Test site is protected by HTTP basic auth at the proxy.
- PM2 under `pm2-daitcrm` runs `crm-live`, `crm-live-worker`, `crm-test`, `crm-test-worker`. Env files in
  `~/<env>/shared/.env` (mode 600).
- Deploy: GitHub Actions builds, runs tests, rsyncs a release folder to `~/<env>/releases/<sha>`, runs
  `prisma migrate deploy`, switches `current`, reloads PM2, smoke-tests `/api/health`. Push to `main` deploys to test;
  live deploy is a manually triggered workflow Deepak runs. Rollback = switch `current` back and restart.
- Nightly `pg_dump` to `~/backups` kept 14 days, plus an off-server copy (rclone to OneDrive, folder to be chosen by Deepak).
- Uptime check on `/api/health` for live.

**Release 1 scope (Leads and Companies):** sign-in, users and roles, Settings (preferences, lookup values, allocation
rules, users), Companies (list, 7-tab profile, contacts, locations; AI tabs present but empty until release 4),
Contacts, Leads (list with tiles/tabs/filters/sort/paging, create lead/prospect with live duplicate detection, CSV
import, lead page with profile box, status rules, Log call, follow-ups, transfer with note, timeline), Tasks, Notifications,
Dashboard, the public contact form endpoint + the six-field form page served for daitpartners.com to embed or link, Enquiries
screen with the Needs-review queue, Reports (the prototype's set), three languages. Email, Mailer, Calendar, Quotations and
Projects are visible in the sidebar only when their release ships.

**Carried-over fixes from the review** (built into release 1): phone layout (sidebar collapses to a top bar below
900 px), confirmations on every destructive action, real column sorting and bulk actions on lists, inline validation,
Settings split into My settings / Administration, real popover for "More", tab roles and focus styles, escaping of every
rendered value, safe URL schemes only, enquiry matching by business-email domain only (typed website and phone matches go
to review).

**Public contact form:** `POST /api/public/enquiries` with honeypot, per-IP rate limit, server-issued token with a
short lifetime, optional Cloudflare Turnstile (key in env). It is the only unauthenticated write. It returns within one
second; matching and allocation run synchronously as the spec requires, enrichment is queued.

## 6. Pending decisions from Deepak

The development plan (section 8) lists five decisions DAIT Partners put on hold on 20 Nov 2026. They are still open.
Release 1 can be built, but cannot go live until they are answered:

1. Which removed lead-page actions return (clone, edit details, archive, reassign, close reason, switch contact, full history).
2. Whether staff need the Enquiries screen (this design assumes yes, with the Needs-review queue).
3. Allocation rules: which countries/sources go to which salesperson.
4. Roles: who sees all leads and who sees only their own (this design assumes the split in section 5).
5. Real dropdown values (sources, statuses, industries, segments). The prototype's lists seed the test site meanwhile.

Also before later releases: Mailer users and daily limit, lawful-basis wording, working hours (release 2); tax rate and
currencies (release 3); AI budget and allowed sources (release 4). And one hosting item: the OneDrive folder for backups.

## 7. Left to the builder

- Exact Prisma schema derived from `docs/data-model.md` and the prototype's `js/data.js`, including indexes.
- API route design, pagination format, error format.
- Component structure in React, how `css/app.css` is split, the combobox implementation.
- Seed data for the test site (fictional, matching the prototype's samples) and the e2e seed.
- Job runner design in the worker, retry policy.
- CSV import mapping UI details.
- The order of tasks inside release 1, written in the implementation plan.

## 8. How the work runs

Per release: implementation plan (superpowers writing-plans) → build on a branch with tests → deploy to the test site →
Deepak walks through the owner checklist (`docs/RELEASE-n-CHECKLIST.md`) → fixes → Deepak triggers the live deploy.
Each release ends with the handover notes updated (`docs/DEPLOYMENT.md`).
