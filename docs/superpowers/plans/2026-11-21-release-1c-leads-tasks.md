# Release 1C — Leads & Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leads and Prospects worked from New to Won with tasks, transfers, a timeline, CSV import, a Tasks page and Notifications, on top of the 1B company master; plus one Prospect per company imported on 21 Nov.

**Architecture:** Same monorepo. `apps/api` gains four Prisma models and a `leads/` module whose single `applyStatusChange` service owns every status side-effect (Won → client, closed → follow-up cleared and tasks closed) and whose `syncFollowUpTask` keeps the follow-up task in step; routes call these from every screen. `packages/shared` gains lead/task Zod schemas and the CSV mapping types. `apps/web` gains `pages/leads/*`, `pages/tasks/*`, `pages/notifications/*` on the 1B list/modal components, after three shared helpers are extracted first.

**Tech Stack:** unchanged (Node 24, Fastify 5, Prisma 6.19, Zod 3.25, React 18, TanStack Query 5, react-hook-form, Vitest 3, Playwright 1.65). One new dependency allowed for CSV parsing on the server: `csv-parse` (pin a version ≥ 14 days old; check `npm view csv-parse time`).

**Spec:** `docs/superpowers/specs/2026-11-21-release-1c-leads-tasks-design.md`. Companions: `docs/DAIT-CRM-Specification-v2.md` §4 (lead fields, functionality, statuses), `docs/data-model.md` Module 1 and `tasks`, fresh-build design §5 (roles), prototype `prototype/js/views-leads2.js` (list tiles/tabs/columns), `views-lead-detail.js` (lead page), `views-work.js` (`V.tasks`), `store.js` lines 95–122 and 140–215 (`ensureFollowUpTask`, `applyStatusEffects`, `createLead`, `transferLead`, `logCall`).

## Global Constraints

- Everything in the 1A/1B Global Constraints still applies (Node ≥ 24, pinned deps, brand, role labels, three languages keyed by English phrase with `es.json`/`fr.json` complete and `npm run i18n:check` clean, combobox for ≥ 8 options, escaped output, `safeUrl`, root `npm test` green before every "done" commit, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`).
- Lead number format `LD-1001` upward from sequence `lead_number_seq START 1001` via `next_lead_number()` (same pattern as `next_company_number()`, no zero-padding).
- **Migration folder name must sort after `20261122100000_companies_contacts`**: use `20261123100000_leads_tasks`. The generated SQL must NOT contain `DROP INDEX "contacts_one_primary_per_company"`; strip it if Prisma emits it (test in Task 1 pins the index).
- Statuses: lookup `lead_status` values; closed set = `['Won','Lost','Not Relevant']` exported as `CLOSED_STATUSES` from shared. Lead types `Lead | Prospect`. Priorities `High | Medium | Low`. Task origins `follow_up | new_assignment | transfer | manual | quotation`. Activity types `call | email | meeting | note | research | status | assign | transfer | ai | created | quote`.
- Visibility (fresh-build §5 + builder's calls): Administrator, Manager → all leads. Sales Representative → `assignedToId = me OR assignedToId IS NULL`. Data Research User → `leadType = 'Prospect' OR assignedToId = me`. `companyWhere` for non-`view_all_companies` roles becomes `createdById = me OR leads.some(assignedToId = me)`. Hidden → 404.
- Every assignment change (create with assignee, transfer, claim, unassign, bulk assign) writes a `lead_assignments` row. Manual transfer requires a non-empty note (1–1000 chars). Lost / Not Relevant require a `reason` (1–500 chars).
- Optimistic concurrency and audit as in 1B (`updatedAt` → 409 `stale`; audit `entityType` `lead` / `task`).
- Error codes added: `transfer_note_required`, `reason_required`, `cannot_assign_hidden`, `lead_archived`, `invalid_status`, `csv_invalid`.
- Pagination format as 1B (`{ items, total, page, pageSize }`, pageSize ≤ 100).

## Review Focus

1. A lead marked Won from the Log-call dialog must have exactly the same effects as Won from the status stepper: company flagged Client, one "Converted to client" activity, follow-up cleared, open tasks closed. (Task 3 test `won via log call equals won via status`.)
2. Changing the follow-up date three times must leave exactly one open follow-up task, re-dated, assigned to the current owner; clearing it removes that task; closing the lead removes it too. (Task 3 tests `follow-up task is upserted not duplicated`, `clearing follow-up removes its task`.)
3. A Sales Representative must be able to see and claim an unassigned lead but never see another rep's lead, in the list, the page, and the tasks list. (Task 4 tests `rep sees unassigned and own only`, `rep claims an unassigned lead`; Task 6 test `tasks list hides other reps' tasks`.)
4. Transfer must move open tasks to the receiver, notify them, and refuse an empty note; transferring to a deactivated user must be refused. (Task 5 tests `transfer moves open tasks and notifies`, `transfer refuses empty note`, `transfer refuses inactive user`.)
5. A CSV with a row whose company matches on domain must link, not create; a row with an unknown country must be reported per row, not fail the whole file. (Task 7 tests `csv links on domain match`, `csv reports bad rows and imports the rest`.)

---

### Task 0: Carry-overs from the 1B review (shared helpers)

**Files:**
- Create: `apps/api/src/prismaErrors.ts`, `apps/web/src/hooks/useUrlListState.ts`, `apps/web/src/forms/applyServerIssues.ts`
- Modify: `apps/api/src/routes/companies.ts`, `contacts.ts`, `locations.ts` (use `prismaErrors`; GET/PATCH company use `assertCompanyVisible`), `apps/api/src/companies/visibility.ts` (add `visibleCompanyIds`), `apps/web/src/pages/companies/CompaniesList.tsx`, `apps/web/src/pages/contacts/ContactsList.tsx` (use the hook), `CompanyModal.tsx`, `ContactModal.tsx`, `LocationModal.tsx`, `pages/settings/UserModal.tsx` (use `applyServerIssues`), `apps/web/src/components/Combobox.tsx` (skip local filtering when `onQuery` is set), `apps/web/src/pages/companies/tabs/ContactsTab.tsx` (move `contactName` to `apps/web/src/api/contacts.ts`)
- Test: existing suites must stay green; add `apps/api/test/visibility.test.ts` (`visibleCompanyIds returns only visible ids`), `apps/web/test/useUrlListState.test.tsx` (reads/writes `q`, `sort`, `dir`, `page`; clamps page ≥ 1).

**Interfaces:**
- Produces: `prismaErrors.ts` exports `isUniqueViolation(e, target?: string): boolean` (checks `meta.target` includes `target` when given), `isNotFound(e): boolean` (P2025), `class StaleError extends Error { code = 'stale' }`.
- Produces: `visibleCompanyIds(db, user, ids: number[]): Promise<Set<number>>`.
- Produces: `useUrlListState<S extends string>(opts: { sorts: readonly S[]; defaultSort: S; extra?: string[] })` → `{ params: { q, sort, dir, page, [extra] }, set(partial), reset() }` with search-param persistence identical to the 1B behaviour.
- Produces: `applyServerIssues(err: unknown, fields: readonly string[], setError, t): { formMessage: string | null }`.

- [ ] **Step 1: Write the two new tests; run them — FAIL.**
- [ ] **Step 2: Extract the helpers and switch every listed call site; no behaviour change.**
- [ ] **Step 3: Run root `npm test` — all green (same counts as 1B: shared 88, api 165+1, web unit 25+1, e2e 18). Commit** `refactor: shared prisma errors, visible ids, url list state, server issue mapping`.

---

### Task 1: Schema and shared schemas for leads, activities, assignments, tasks

**Files:**
- Modify: `prisma/schema.prisma` (models `Lead`, `LeadActivity`, `LeadAssignment`, `Task`; relations on `User` (`assignedLeads`, `tasks`), `Company` (`leads`), `Contact` (`leads`), `AllocationRule` (`assignments`); `Contact.isActive Boolean @default(true)`)
- Create: `prisma/migrations/20261123100000_leads_tasks/migration.sql` (generated, then append `CREATE SEQUENCE lead_number_seq START 1001; CREATE FUNCTION next_lead_number() … 'LD-' || n …; ALTER TABLE leads ALTER COLUMN number SET DEFAULT next_lead_number();` and verify no DROP INDEX line)
- Create: `packages/shared/src/schemas/lead.ts`, `schemas/task.ts`, `src/leads.ts` (constants)
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/leadSchema.test.ts`, `apps/api/test/leadNumber.test.ts`, extend `apps/api/test/contacts.test.ts` (`partial unique index still present after 1C migration`: query `pg_indexes`).

**Interfaces:**
- Produces (Prisma `Lead`): `id`, `number String @unique @default(dbgenerated("next_lead_number()"))`, `leadType String` ('Lead'|'Prospect'), `companyName String`, `companyId Int?`, `contactId Int?`, `website?`, `businessEmail?`, `phone?`, `country String`, `city?`, `leadSource String`, `sourceUrl?`, `importBatch?`, `assignedToId Int?`, `priority String @default("Medium")`, `status String @default("New")`, `nextFollowUp DateTime? @db.Date`, `notes?`, `enquiryId Int?` (no relation yet), `enrichmentStatus String @default("Pending")`, `convertedTo?`, `archivedAt?`, `createdById Int?`, `createdAt`, `updatedAt`; indexes on `status`, `assignedToId`, `companyId`, `leadType`, `nextFollowUp`, `createdAt`, `[country]`. `LeadActivity`: `leadId`, `activityType`, `title`, `body?`, `url?`, `statusFrom?`, `statusTo?`, `relatedType?`, `relatedId?`, `byUserId Int?`, `occurredAt @default(now())`; index `[leadId, occurredAt]`. `LeadAssignment`: `leadId`, `fromUserId?`, `toUserId Int?`, `byUserId?`, `ruleId?`, `note?`, `assignedAt`. `Task`: `leadId Int?`, `quotationId Int?` (plain column), `title`, `dueDate @db.Date`, `assignedToId Int`, `isDone @default(false)`, `doneAt?`, `origin String`, `closedReason?`, `createdAt`, `updatedAt`; indexes `[assignedToId, isDone, dueDate]`, `[leadId, origin, isDone]`.
- Produces (shared `leads.ts`): `LEAD_TYPES`, `PRIORITIES`, `CLOSED_STATUSES = ['Won','Lost','Not Relevant'] as const`, `TASK_ORIGINS`, `ACTIVITY_TYPES`, `isClosedStatus(s)`.
- Produces (shared `schemas/lead.ts`): `LeadCreate` (`leadType` default 'Lead', `companyName` 1–200 required, `companyId?` int, `contactId?` int, `website?` (optionalUrl), `businessEmail?`, `phone?`, `country` required, `city?`, `leadSource` required, `sourceUrl?`, `assignedToId?` int|null, `priority` default 'Medium', `status` default 'New', `nextFollowUp?` ISO date `YYYY-MM-DD`|null, `notes?` ≤ 5000, `linkCompanyId?` int (use this company instead of matching), `createCompany` boolean default true); `LeadUpdate` = editable fields partial + `updatedAt`; `LeadStatusChange = { status, reason?, updatedAt }`; `LeadTransfer = { toUserId: int|null, note: 1–1000 }` (note required unless `toUserId` is the actor claiming an unassigned lead — then optional); `LogCall = { outcome: enum ['Connected','No answer','Voicemail','Wrong number','Callback requested'], minutes?: int 0–600, body?: ≤ 2000, statusAfter?: string, nextFollowUp?: date|null, updatedAt }`; `LeadListQuery = PagingQuery + { tab?: 'all'|'leads'|'prospects'|'mine'|'overdue'|'unassigned', status?, source?, country?, assignedTo?: int|'none', leadType?, priority?, from?, to?: date, sort: enum ['number','companyName','contact','country','leadType','leadSource','status','priority','assignedTo','nextFollowUp','createdAt'] }`; `LeadBulk = { ids: int[] (1–100), action: 'assign'|'archive'|'unarchive', toUserId?: int|null, note?: string }`; `SwitchContact = { contactId: int|null, updatedAt }`.
- Produces (shared `schemas/task.ts`): `TaskCreate = { leadId?: int, title 1–200, dueDate: date, assignedToId: int }`, `TaskUpdate = { title?, dueDate?, assignedToId?, isDone?, updatedAt }`, `TaskListQuery = PagingQuery + { tab: 'today'|'overdue'|'upcoming'|'done' default 'today', assignedTo?: int|'all' }`.
- Consumes: Task 0 nothing; 1B `optionalText/optionalUrl/optionalEmail`, `PagingQuery`.

- [ ] **Step 1: Write `leadSchema.test.ts`:** `LeadCreate` requires `companyName`, `country`, `leadSource`; defaults `leadType 'Lead'`, `priority 'Medium'`, `status 'New'`; rejects `nextFollowUp: '2026-13-01'`; `LeadTransfer` rejects `note: ''` when `toUserId` set; `LeadStatusChange` accepts `{ status:'Lost', reason:'Budget', updatedAt }`; `TaskListQuery` defaults `tab 'today'`.
- [ ] **Step 2: Run — FAIL. Write the schemas, constants, Prisma models. `npx prisma migrate dev --name leads_tasks` on `dait_crm_1a_dev`, rename the folder to `20261123100000_leads_tasks` if Prisma named it with today's timestamp, append the sequence/function SQL, delete any `DROP INDEX "contacts_one_primary_per_company"` line, `prisma migrate reset --force` is NOT allowed (ask: use `--create-only` + re-apply as in 1B), `npx prisma generate`.**
- [ ] **Step 3: Write `leadNumber.test.ts`:** first created lead gets `LD-1001`, second `LD-1002`; `setval` to 99999 → `LD-100000`. Extend `contacts.test.ts` with `partial unique index still present` (`SELECT indexname FROM pg_indexes WHERE indexname='contacts_one_primary_per_company'` → 1 row).
- [ ] **Step 4: Run shared + api tests — PASS; `npm run typecheck` clean. Commit** `feat(db): leads, activities, assignments, tasks tables and shared schemas`.

---

### Task 2: Lead visibility, serializers, and the status/follow-up service

**Files:**
- Create: `apps/api/src/leads/visibility.ts`, `apps/api/src/leads/serialize.ts`, `apps/api/src/leads/service.ts`, `apps/api/src/leads/notify.ts`
- Modify: `apps/api/src/companies/visibility.ts` (`companyWhere` ORs `leads: { some: { assignedToId: user.id } }` for non-`view_all_companies`)
- Test: `apps/api/test/leadService.test.ts`, extend `apps/api/test/companies.test.ts` (`rep sees a company through an assigned lead`).

**Interfaces:**
- Produces (`visibility.ts`): `leadWhere(user: AuthUser): Prisma.LeadWhereInput` per Global Constraints (always `archivedAt: null` unless caller overrides); `assertLeadVisible(db, user, id, opts?: { includeArchived?: boolean }): Promise<Lead>` (NotFoundError); `canSeeLead(db, user, leadId): Promise<boolean>`.
- Produces (`serialize.ts`): `leadSummary(l)` → `{ id, number, leadType, companyName, companyId, company: { id, number, name } | null, contact: { id, name, email, linkedinUrl } | null, country, city, leadSource, status, priority, assignedTo: { id, name } | null, nextFollowUp (YYYY-MM-DD|null), isOverdue: boolean, archivedAt, createdAt, updatedAt }`; `leadDetail(l)` → every column + `company` summary (industry, city, country, employeeRange, isClient, verificationStatus, contactCount, openLeadCount) + `contact` + `createdBy`; `activityRow(a)`; `assignmentRow(r)`; `taskRow(t)` → `{ id, leadId, lead: { id, number, companyName } | null, title, dueDate, assignedTo: { id, name }, isDone, doneAt, origin, closedReason, isOverdue, isToday, updatedAt }` (today computed in the user's timezone from `AuthUser.timezone`).
- Produces (`service.ts`, all take `tx: Prisma.TransactionClient` and run inside the caller's transaction):
  - `applyStatusChange(tx, lead: Lead, to: string, by: { userId: number | null }, opts?: { reason?: string; sourceTitle?: string }): Promise<Lead>` — validates `to` is an active `lead_status` lookup (`invalid_status`), no-op if unchanged, requires `reason` for Lost/Not Relevant (`reason_required`), writes a `status` activity (`title: 'Status changed to {to}'`, `statusFrom/To`, `body` = reason or `sourceTitle`), Won → `convertedTo='client'`, company `isClient=true`, extra activity `title 'Converted to client'` body `'Previous status {from}. Company {number} flagged as Client.'`; closed → `nextFollowUp=null`, `closeOpenTasks(tx, lead.id, 'Lead closed as {to}')`, note activity `'{n} open task(s) closed'` by system when n>0.
  - `syncFollowUpTask(tx, lead: Lead): Promise<void>` — if `nextFollowUp && assignedToId`: upsert the single open task `{ leadId, origin:'follow_up', isDone:false }` with `title 'Follow up · {companyName}'`, `dueDate`, `assignedToId`; else delete that open task.
  - `closeOpenTasks(tx, leadId, closedReason): Promise<number>`.
  - `recordAssignment(tx, lead, toUserId: number | null, by: { userId: number | null; ruleId?: number | null; note?: string }): Promise<Lead>` — writes `lead_assignments`, updates `assignedToId`, moves open tasks (`assignedToId` of open tasks on the lead → `toUserId`, or leaves them when null), activity type `assign`/`transfer`, creates a `new_assignment` task `'Review new lead · {companyName}'` due today for a new assignee on create, notifies the receiver (`notify.ts`). Refuses an inactive `toUserId` (`unknown_user`).
  - `createLeadWithCompany(tx, input: LeadCreate, user: AuthUser): Promise<Lead>` — resolves company: `linkCompanyId` (must be visible) → else `findCompanyMatches` auto hit → else if `createCompany` create company (name, website, businessEmail, country, city, `createdById`) and, when `businessEmail` or `phone` given, a primary contact from them (no name → contact skipped); sets `contactId` (given, else company's primary); `assignedToId` given → `recordAssignment` by user; else `pickAssignee(tx, country)` → `recordAssignment` with `ruleId`; `created` activity `'Lead created'`; `syncFollowUpTask`; `enrichmentStatus 'Pending'`.
- Produces (`notify.ts`): `notifyUser(tx, userId, text, detail?, link?): Promise<void>` inserting a `Notification` row.
- Consumes: 1A `pickAssignee`, 1B `findCompanyMatches`, `assertLookupValue`, `assertCompanyVisible`.

- [ ] **Step 1: Write `leadService.test.ts`** (direct service calls inside `prisma.$transaction`, factories `makeLead(overrides)` added to `apps/api/test/factory.ts`): `won flags company client and writes one converted activity`; `won via log call equals won via status` (call `applyStatusChange` with `sourceTitle:'Log call'` and compare resulting lead/company/activity counts to a plain call); `closing clears follow-up and closes open tasks with a note`; `lost without reason is refused`; `follow-up task is upserted not duplicated` (set three dates → one open task with the last date); `clearing follow-up removes its task`; `recordAssignment moves open tasks and notifies`; `createLeadWithCompany links on domain match`, `creates company and primary contact when nothing matches`, `uses allocation rule when unassigned` (seed one rule for 'India'); `inactive status value is refused`.
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Extend `companies.test.ts` with the assigned-lead visibility case. `npm test -w apps/api` all green. Commit** `feat(api): lead status, follow-up and assignment service`.

---

### Task 3: Leads API (list, create, read, update, status, log call, follow-up, switch contact, archive, bulk, duplicate check)

**Files:**
- Create: `apps/api/src/routes/leads.ts`
- Modify: `apps/api/src/app.ts`, `packages/shared/src/rights.ts` (add `manage_leads` all four roles; `view_all_leads` exists for Admin/Manager; `claim_leads` Sales Representative + Admin/Manager)
- Test: `apps/api/test/leads.test.ts`

**Interfaces (all `requireUser`; writes `requireRight('manage_leads')`):**
- `GET /leads` (`LeadListQuery`): `tab` filters: `leads` → leadType Lead; `prospects`; `mine` → assignedToId me; `overdue` → open follow_up task with dueDate < today in user tz, status not closed; `unassigned` → assignedToId null. `q` matches number, companyName, contact first/last, businessEmail. Returns `{ items: leadSummary[], total, page, pageSize, tiles: { newThisWeek, newThisWeekFromWebsite, followUpsDueToday, overdue, unassigned }, counts: { all, leads, prospects, mine, overdue, unassigned } }` (counts respect visibility).
- `POST /leads` (`LeadCreate`) → 201 `leadDetail`; `cannot_assign_hidden` when `assignedToId` cannot see the lead (not Admin/Manager and not the assignee rule? — rule: assignee must be an active user; Sales Rep may only assign to self or leave unassigned).
- `GET /leads/:id` → `leadDetail` + `activities` (latest 15, `?activitiesPage`), `assignments`, `tasks` (open), `activityTotal`.
- `PATCH /leads/:id` (`LeadUpdate`) — edit details; `nextFollowUp` change → `syncFollowUpTask`; archived → `lead_archived`.
- `POST /leads/:id/status` (`LeadStatusChange`) → `applyStatusChange`.
- `POST /leads/:id/log-call` (`LogCall`) → `call` activity (`title 'Call · {outcome}'`, body, `minutes` in body prefix), then optional `applyStatusChange(sourceTitle:'Log call')`, then `nextFollowUp` + `syncFollowUpTask`; one transaction.
- `POST /leads/:id/contact` (`SwitchContact`) — contact must belong to the lead's company and be active; `assign`-type activity `'Contact switched to {name}'`.
- `POST /leads/:id/archive` / `unarchive` (`{ updatedAt }`) — sets/clears `archivedAt`; archived leads excluded from lists by default (`?archived=1` for Admin/Manager).
- `POST /leads/bulk` (`LeadBulk`) → `{ updated }`; `assign` requires `note` when any lead is currently assigned to someone else.
- `POST /leads/check-duplicates` → proxies `findCompanyMatches` with lead-visibility redaction as 1B.
- Audit on every write.

- [ ] **Step 1: Write `leads.test.ts`:** `401 when signed out`; `creates a lead with LD- number, links company on domain and audits`; `rep sees unassigned and own only` (three leads: rep's, other rep's, unassigned → list total 2, GET other → 404); `data research user sees prospects and own leads`; `list tabs and tiles count correctly`; `overdue tab uses the user's timezone`; `status change to Won via route flags client`; `log call with status and follow-up in one go`; `switch contact refuses contact of another company`; `archive hides the lead and refuses edits`; `bulk assign writes assignment rows and requires a note`; `rejects a stale update`; `sort whitelist 400`.
- [ ] **Step 2: Run — FAIL. Implement routes + rights (update `auth.test.ts` expectations). Run `npm test -w apps/api` — PASS. Commit** `feat(api): leads routes`.

---

### Task 4: Transfer, claim, unassign; Tasks and Notifications API

**Files:**
- Create: `apps/api/src/routes/tasks.ts`, `apps/api/src/routes/notifications.ts`
- Modify: `apps/api/src/routes/leads.ts` (add transfer/claim/unassign), `apps/api/src/app.ts`
- Test: `apps/api/test/transfer.test.ts`, `apps/api/test/tasks.test.ts`, `apps/api/test/notifications.test.ts`

**Interfaces:**
- `POST /leads/:id/transfer` (`LeadTransfer`) → `recordAssignment` with note; `transfer_note_required` when note empty and `toUserId !== me`; receiver must be able to see the lead after transfer (always true since assignee) and be active; sends notification `'Lead transferred to you · {companyName} from {fromName}'` with detail = note, link `/leads/{id}`.
- `POST /leads/:id/claim` (`requireRight('claim_leads')`, `{ updatedAt }`) — only when `assignedToId` is null → `recordAssignment(me)`.
- `POST /leads/:id/unassign` (`{ note, updatedAt }`, Admin/Manager) → `recordAssignment(null)`.
- `GET /tasks` (`TaskListQuery`): default `assignedTo` = me; `all` only for `view_all_leads`; visibility = task's lead visible or task has no lead and is mine; `tab` today/overdue/upcoming/done computed in user tz; returns `{ items: taskRow[], total, page, pageSize, counts: { today, overdue, upcoming, done } }`.
- `POST /tasks` (`TaskCreate`, origin `manual`) — assignee must be able to see the lead (`cannot_assign_hidden`).
- `PATCH /tasks/:id` (`TaskUpdate`): tick (`isDone` → `doneAt`), re-date, retitle, reassign (same visibility rule); `POST /tasks/:id/snooze` → dueDate = tomorrow in user tz.
- `GET /notifications?unread=1&page` → `{ items, total, unread }`; `POST /notifications/:id/read`; `POST /notifications/read-all`; `GET /notifications/count` → `{ unread }`.

- [ ] **Step 1: Write the three test files:** `transfer moves open tasks and notifies`; `transfer refuses empty note`; `transfer refuses inactive user`; `rep claims an unassigned lead`; `rep cannot claim an assigned lead`; `unassign writes a row with null`; `tasks list hides other reps' tasks`; `tabs classify by the user's timezone` (set user tz `Asia/Kolkata`, create due dates around midnight UTC); `tick sets doneAt`; `snooze moves to tomorrow`; `reassign to someone who cannot see the lead is refused`; `notifications list, read, read-all, count`.
- [ ] **Step 2: Run — FAIL. Implement. Run `npm test -w apps/api` — PASS. Commit** `feat(api): transfer, claim, tasks and notifications`.

---

### Task 5: CSV import API and the 21 Nov prospect migration script

**Files:**
- Create: `apps/api/src/leads/csv.ts`, `apps/api/src/routes/imports.ts`, `apps/api/src/cli/import-prospects-2026-11-21.ts` (compiled to `dist/cli/…`)
- Modify: `apps/api/package.json` (add `csv-parse`), `packages/shared/src/schemas/lead.ts` (`CsvMapping`)
- Test: `apps/api/test/csvImport.test.ts`, `apps/api/test/importProspects.test.ts`

**Interfaces:**
- `CsvMapping = { columns: Record<'companyName'|'website'|'businessEmail'|'phone'|'country'|'city'|'contactFirstName'|'contactLastName'|'contactEmail'|'leadSource'|'priority'|'notes'|'sourceUrl', string | null> }` (CSV header name per field; `companyName` and `country` required).
- `POST /imports/leads/preview` (multipart or JSON `{ csv: string }` ≤ 5 MB) → `{ headers: string[], sample: string[][] (first 5 rows), rowCount, suggestedMapping: CsvMapping }` (suggest by case-insensitive header match).
- `POST /imports/leads` body `{ csv, mapping: CsvMapping, leadSource: default 'CSV Import', assignedToId?: int|null }` → `{ batch: 'CSV-YYYYMMDD-HHMM', created: number, linked: number, review: [{ row, companyName, candidates: [{ id, number, name, how }] }], errors: [{ row, message }] }`. Rules: each row → `createLeadWithCompany` with `leadType 'Prospect'`, `importBatch`; domain auto-match links; review candidates (legal name / name+country) → the row is still created as a Prospect **linked to no company** (`companyId null`) and listed in `review` so the user resolves it on the lead page (spec: nullable until duplicate check resolves); rows with unknown `country` (not in lookup) or missing name → `errors`, rest imported. Everything in one transaction per row so one bad row doesn't abort the batch.
- `POST /leads/:id/resolve-company` body `{ companyId: int | 'create', updatedAt }` → links or creates the company for a review row.
- CLI `import-prospects-2026-11-21.ts`: `--file <leads_pending_1C.csv> --owners "Deepak=<email>,Carlos=<email>" [--dry-run]`; for each row find the company by `name + country` (companies were created by the 1B import with exact names) → create a Prospect `leadSource 'CSV Import'`, `importBatch 'IMPORT-2026-11-21'`, `status` from `pipeline_stage` (`1. Identified`/`2. Researched` → `New`, contains `Contacted` → `Contacted`, else `New`), `priority` from the sheet's Priority column when High/Medium/Low else `Medium`, `assignedToId` = owner's user, `notes` = Notes column, `contactId` = company primary, `nextFollowUp` null; skip when a Prospect with that `importBatch` and company already exists (idempotent). Dry run prints the tally.

- [ ] **Step 1: Write `csvImport.test.ts`:** `preview suggests a mapping from headers`; `csv links on domain match`; `csv reports bad rows and imports the rest`; `csv row with name+country review candidate is created unlinked and listed`; `resolve-company links a review row`. Write `importProspects.test.ts`: seed two companies, a 3-row CSV fixture → 2 prospects created with mapped status/priority/owner, 1 unknown company skipped; running twice creates nothing new.
- [ ] **Step 2: Run — FAIL. `npm view csv-parse time` and pin a version ≥ 14 days old. Implement. Run — PASS. Commit** `feat(api): csv lead import and 21 Nov prospect migration`.

---

### Task 6: Web — Leads list, create lead, Tasks page, Notifications page

**Files:**
- Create: `apps/web/src/api/leads.ts`, `api/tasks.ts`, `api/notifications.ts`, `pages/leads/LeadsList.tsx`, `pages/leads/LeadModal.tsx`, `pages/leads/CsvImportModal.tsx`, `pages/tasks/TasksList.tsx`, `pages/tasks/TaskModal.tsx`, `pages/notifications/NotificationsList.tsx`, `components/Tile.tsx`, `components/StatusBadge.tsx`
- Modify: `router.tsx` (`/leads`, `/tasks`, `/notifications`; keep `/leads/:id` for Task 7), `Placeholder.tsx` (remove the three), `Sidebar.tsx` (unread badge on Notifications via `useNotificationCount` polling 60 s), `i18n/labels.ts` (`leadStatusText`, `priorityText`, `taskOriginText`, `errorText` cases), `locales/es.json`, `fr.json`
- Test: `apps/web/test/leadModal.test.tsx` (duplicate hint + server issue mapping via `applyServerIssues`), `apps/web/e2e/leads.spec.ts`, `apps/web/e2e/tasks.spec.ts`

**Interfaces:**
- `LeadsList`: three tiles (`New this week` / `Follow-ups due today` → `/tasks` / `Unassigned` → `?tab=unassigned`), tab bar (All leads, Leads, Prospects, My leads, Overdue follow-ups, Unassigned) with counts, toolbar (search, status, source, country, assigned-to, priority, date range, "Import CSV", "New lead"), table columns Lead ID, Company name, Contact person, Country, Type, Source, Status, Priority, Assigned to, Next follow-up, Created; checkbox + bulk bar (Assign to…, Archive) with confirm; URL state via `useUrlListState` with `extra` filters; row → `/leads/:id`.
- `LeadModal({ lead?, onClose })`: fields from spec §4.2 (company name with live `DuplicateHint` from `/leads/check-duplicates`; "Link to existing company" picker (reuse `CompanyPicker` from ContactModal, extract to `components/CompanyPicker.tsx`); contact picker filtered by company; country combobox; source select; assigned-to select (Sales Rep sees only self + Unassigned); priority; status (create only: New); follow-up date; notes).
- `CsvImportModal`: step 1 paste or choose file → preview; step 2 mapping selects per field; step 3 result summary with review rows linking to each lead page.
- `TasksList`: tabs Today / Overdue / Upcoming / Done with counts; rows (checkbox tick, title, lead link, due, assigned, origin); actions Edit (`TaskModal`), Snooze; "New task" (manual, with lead picker from `/leads?q=`).
- `NotificationsList`: unread first, mark read on click (navigates to link), "Mark all read".
- e2e `leads.spec.ts`: `creates a lead linked to an existing company via duplicate hint` (Maya; New lead; company name "Northwind Logistics", website `https://northwindlogistics.in` → blocking "This looks like CO-0318"? — NO: for leads an auto match should offer "Link to CO-0318" and Save stays enabled (multiple leads per company); assert the created lead row shows company Northwind and an `LD-` number); `sales rep sees unassigned leads and claims one from the list` (Arjun; a seeded unassigned lead; bulk Assign to me). e2e `tasks.spec.ts`: `follow-up date creates a task that appears under Upcoming and can be ticked`.
- Note for the implementer: the e2e seed (`apps/api/test/e2e-seed.ts`) must gain 3 leads (one assigned to Arjun with a follow-up tomorrow, one unassigned, one assigned to Maya) via `makeLead`-style inserts using `createLeadWithCompany`.

- [ ] **Step 1: Unit test `leadModal.test.tsx` and the e2e specs — RED.**
- [ ] **Step 2: Implement. `npm run test:unit -w apps/web`, `npm test -w apps/web`, `npm run i18n:check`, `npm run typecheck` — green. Commit** `feat(web): leads list, create lead, csv import, tasks and notifications pages`.

---

### Task 7: Web — Lead page

**Files:**
- Create: `pages/leads/LeadPage.tsx`, `pages/leads/StatusStepper.tsx`, `pages/leads/LogCallModal.tsx`, `pages/leads/TransferModal.tsx`, `pages/leads/CloseLeadModal.tsx`, `pages/leads/SwitchContactModal.tsx`, `pages/leads/Timeline.tsx`, `pages/leads/ProfileBox.tsx`, `pages/leads/MoreMenu.tsx` (real popover, UX M2)
- Modify: `router.tsx` (`/leads/:id`), `pages/companies/tabs/EmptyTab.tsx` usage → new `pages/companies/tabs/LeadsTab.tsx` and `ActivitiesTab.tsx` on the company profile (leads of the company; activities across its leads), `CompanyProfile.tsx`
- Test: `apps/web/test/statusStepper.test.tsx`, `apps/web/e2e/leadPage.spec.ts`

**Interfaces:**
- `LeadPage`: Topbar title `{companyName}`, sub `{number} · {status} · {assignedTo}`; action row: Log call, Set follow-up (inline date), Transfer, Close (Won / Lost / Not Relevant; reason required for the last two), More ▾ (Edit details, Switch contact, Archive with confirm, Unassign for Admin/Manager). Left: `ProfileBox` (company card with link, contact card with mailto/tel via `safeUrl`, lead facts). Right: `StatusStepper` (lookup order; clicking a step → status change; closed statuses only via Close dialog) and `Timeline` (latest 15, "Show earlier" loads the next page; icons per activity type; status rows show from → to).
- `LogCallModal`: outcome select, minutes, note, "Status after call" select (optional), "Next follow-up" date; one POST.
- `TransferModal`: user combobox (active users who can see leads: Admin/Manager/Sales Rep), note required.
- Company profile `LeadsTab`: table of the company's leads (visible ones) with New lead prefilled; `ActivitiesTab`: merged activities of those leads, newest first, 20 per page.
- e2e `leadPage.spec.ts`: `log call sets status and creates a follow-up task` (open Arjun's seeded lead as Arjun; Log call outcome Connected, status Contacted, follow-up tomorrow → stepper shows Contacted, timeline has Call row, `/tasks` Upcoming shows the task); `transfer requires a note and notifies the receiver` (Maya transfers to Arjun without note → inline error; with note → sign in as Arjun → notifications badge 1, lead in My leads); `closing as Lost needs a reason and clears follow-up` (assert follow-up empty and task gone).

- [ ] **Step 1: Unit test `StatusStepper` (renders statuses in lookup order, closed ones disabled, click fires onChange) and the e2e spec — RED.**
- [ ] **Step 2: Implement. Web unit + e2e + i18n + typecheck green. Commit** `feat(web): lead page with stepper, log call, transfer, close, timeline`.

---

### Task 8: Contacts deactivate/move, Client flag, checklist, wrap-up

**Files:**
- Modify: `apps/api/src/routes/contacts.ts` (`PATCH` accepts `isActive`; `POST /contacts/:id/move { companyId, updatedAt }` — clears `isPrimary` on move if target has one, audit `action 'update'` with before/after companyId), `routes/companies.ts` (`isClient` editable by `view_all_companies` roles only), shared `ContactUpdate` (`isActive?`), `CompanyUpdate` (`isClient?`), `pages/companies/tabs/ContactsTab.tsx` (Deactivate/Reactivate, Move… with company picker), `CompanyModal.tsx` (Client checkbox for Admin/Manager), pickers exclude inactive contacts
- Create: `docs/RELEASE-1C-CHECKLIST.md`
- Modify: `README.md`, `docs/DEPLOYMENT.md` (post-deploy step: run `dist/cli/import-prospects-2026-11-21.js` once with `--dry-run` then for real)
- Test: extend `contacts.test.ts` (`deactivated contact is hidden from pickers and cannot be primary`, `move contact clears primary when target has one`), `companies.test.ts` (`sales rep cannot change isClient`), e2e `companyProfile.spec.ts` (`deactivate a contact`).

- [ ] **Step 1: Tests RED → implement → GREEN.**
- [ ] **Step 2: Write the checklist (create lead with duplicate link, log call, follow-up task, transfer + notification, close with reason, CSV import with a review row, claim as Carlos, tasks page, Spanish). Full root `npm test` + `typecheck` + `i18n:check` green. Commit** `feat: contact deactivate/move, client flag, release 1C checklist`.
- [ ] **Step 3: STOP — no deploy; the controller deploys and runs the prospect migration with the owner's confirmation.**

---

## Self-review notes

- Spec coverage: tables (T1), number sequence (T1), status rules/Won/closed/follow-up (T2 service, T3 routes), transfer/claim/unassign/notifications (T4), allocation on create (T2), CSV import + review (T5), 21 Nov prospect migration (T5), list/tiles/tabs/bulk (T3 + T6), lead page actions per decision 1 (T7), tasks page incl. M5 edit/snooze (T4 + T6), notifications page (T4 + T6), visibility incl. `companyWhere` extension (T2), carry-overs (T0), contacts deactivate/move + isClient (T8), company profile Leads & Activities tabs (T7), tests per task, checklist (T8).
- Deliberately out: enquiries (`enquiryId` column only), AI enrichment (status column only), email/calendar/quotations.
- Name consistency: `applyStatusChange`, `syncFollowUpTask`, `closeOpenTasks`, `recordAssignment`, `createLeadWithCompany`, `leadWhere`, `assertLeadVisible`, `leadSummary/leadDetail/taskRow`, `useUrlListState`, `applyServerIssues`, `prismaErrors`, `visibleCompanyIds`, `CLOSED_STATUSES`, `CsvMapping`, error codes as listed.
- Open point for the implementer of T6: lead duplicate hint is non-blocking (a company may have many leads); the hint offers "Link to {number}" which sets `linkCompanyId`.
