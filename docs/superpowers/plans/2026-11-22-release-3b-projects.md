# Release 3B — Projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prototype's Projects: list page, Create/Edit dialog with stakeholders, Convert to project from an accepted quotation, Projects cards/tab on the lead and company pages, "Mark Won and create project", and project-tagged email (Compose, lead email form, Email filter).

**Architecture:** Tables `projects` + `project_stakeholders`, `email_messages.project_id`, and the real relation for `quotations.project_id`; shared constants/schemas; `apps/api/src/projects/*` (visibility, service) and `routes/projects.ts`; outgoing mail carries an optional project; web `pages/projects/*` plus small changes to existing lead, company, quotation and email screens.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, React/Vite, TanStack Query, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-release-3b-projects-design.md`

## Global Constraints

- Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`); `TZ=Europe/London npm test`; rebuild shared (`npm run build -w packages/shared`) after shared changes; e2e after `npm run build`; Prisma drift check empty; `npm run i18n:check` clean (en/es/fr).
- Statuses exactly `Active | On hold | Completed | Cancelled` (default Active); currencies `USD | CAD | INR` (default: preset → `defaultCurrency(company.country)`).
- Number `PRJ-<n>`, sequential, unique (prototype `PRJ-1`).
- Converted value = accepted (last sent) revision's `grandTotal − taxTotal` (net, before GST), with its currency. Manager on convert = quotation owner.
- One project per quotation (unique key); only Accepted quotations with no project may be converted or linked.
- Visibility: lead rule (archived included) or, without a lead, company rule — **or** `managerId = me`. Edit/create rights per the spec's "Who sees / may change" and builder's calls.
- Mail stays private: the Project filter only narrows the viewer's own mail; a project tag never widens who sees an email.
- No project detail page, no delete, client not changeable, no auto-create on Won, no reports/dashboard change.
- Screens match the prototype (`prototype/js/views-projects.js`, `views-companies.js` projects tab, `views-lead-detail.js` card / Won dialog / email Project picker, `views-work.js` Email Project filter); the last task is a screenshot parity check.
- Never push or deploy without the owner saying "deploy".

## Review Focus

1. A Sales Representative chosen as manager of a project on another rep's lead → sees it in the list, tiles, badge and can edit; still cannot open that lead (404). (Task 2 test.)
2. Convert clicked twice / two users at once → one project; the second call returns the same project. (Task 2 test.)
3. Edit swaps the linked quotation → old quotation's `projectId` cleared (its Convert returns), new one set, history lines on both. (Task 2 test.)
4. Composing with a project whose stakeholder is also the To address → that address not duplicated in Cc; a stakeholder without email skipped. (Task 6 test.)
5. A user filters Email by a project another user also emailed → sees only their own messages. (Task 3 test.)

---

### Task 1: Data and shared definitions

**Files:** `prisma/schema.prisma` + migration `prisma/migrations/20261203100000_projects/`, `packages/shared/src/projects.ts` (new, exported from the index), `packages/shared/src/schemas/project.ts` (new, exported), `apps/api/src/projects/number.ts` (new), tests `packages/shared/test/projects.test.ts`, `apps/api/test/projectNumber.test.ts`.

**Interfaces — Produces:**
- `PROJECT_STATUSES = ['Active','On hold','Completed','Cancelled'] as const`, `type ProjectStatus`.
- `projectBadge(status): 'b-ok' | 'b-grey' | 'b-warn'` (Active → b-ok, Completed → b-grey, else b-warn).
- `primaryStakeholderIds(contacts: { id: number; isPrimary: boolean; contactType: string }[], leadContactId?: number | null): number[]` — lead contact first, then primary or `Decision Maker`, unique.
- `projectCreateSchema` / `projectUpdateSchema` (zod): companyId (create only), leadId?, quotationId?, name (trimmed, 1–200), status, startDate `YYYY-MM-DD`, value? (≥ 0, 2 dp), currency, managerId, stakeholderIds number[], description? ; update adds `updatedAt`.
- Prisma models `Project` (`projects`: id, number unique, companyId, leadId?, quotationId? unique, name, status, startDate @db.Date, value Decimal(14,2)?, currency, managerId, description?, createdById, completedAt?, createdAt, updatedAt) and `ProjectStakeholder` (`project_stakeholders`: projectId, contactId, @@id pair, cascade on project). `EmailMessage.projectId?` → Project (SetNull). `Quotation.projectId` becomes a relation (SetNull); drop the "plain column" comment.
- `nextProjectNumber(tx): Promise<string>` → `PRJ-<n>` using the same locking pattern as `apps/api/src/quotations/number.ts`.

- [ ] Write failing tests: `primaryStakeholderIds` (lead contact first, no duplicates, Decision Maker included, non-primary Other excluded); schemas reject empty name, bad currency, unknown status, negative value; `nextProjectNumber` gives `PRJ-1`, `PRJ-2` and distinct numbers under two concurrent transactions.
- [ ] Run them; expect FAIL.
- [ ] Add schema + migration (hand-check SQL: unique `quotation_id`, FK on `quotations.project_id` with existing NULLs), shared module, number helper; build shared.
- [ ] Run tests + Prisma drift check; expect PASS / empty.
- [ ] Commit `feat(projects): tables, shared statuses and schemas, PRJ numbering`.

### Task 2: Projects API

**Files:** `apps/api/src/projects/visibility.ts`, `apps/api/src/projects/service.ts`, `apps/api/src/routes/projects.ts` (new, registered in `app.ts`), `apps/api/src/routes/navCounts.ts` (+ `projects`), `apps/api/src/routes/quotations.ts` + `apps/api/src/quotations/service.ts` (detail returns `project: { id, number, name } | null`), tests `apps/api/test/projects.test.ts`, `apps/api/test/navCounts.test.ts`.

**Interfaces — Consumes:** Task 1. `leadWhere`, `companyWhere`, `quotationWhere`, `canEditQuotation`, existing activity/notification/audit helpers.
**Produces (HTTP):**
- `GET /api/projects?company=&status=` → `{ items: ProjectRow[], tiles: { active, clients, totals: { currency, amount }[], completedThisYear, onHold }, total }`. `ProjectRow` = id, number, name, status, startDate, value, currency, company {id,name}, lead {id,number}|null, quotation {id,number}|null, manager {id,name}, stakeholders {id,name,email}[], description, updatedAt, canEdit. Newest first. Tiles over all visible projects (not the filter), `clients` = visible client companies.
- `GET /api/companies/:id/projects` → `{ items: ProjectRow[], isClient }`.
- `GET /api/projects/form-options?company=` → client's leads the user can see, Accepted quotations without project, contacts (id, name, designation/type, email, isPrimary, contactType), active users.
- `POST /api/projects` (manage_quotes) → 201 ProjectRow; `PATCH /api/projects/:id` (updatedAt; 409 stale); `POST /api/quotations/:id/convert` → 201 new or 200 existing ProjectRow.
- `projectWhere(user)`, `canEditProject(user, p)`, `canCreateProject(user, company, lead)` in visibility.ts.

- [ ] Write failing tests:
  - create: Client flag set; stakeholders saved; with lead → timeline "Project created · PRJ-1 <name>" detail "Stakeholders: A, B"; manager ≠ creator → notification "Project created · <name>" ("<company> · from LD-…", link `/projects`); manager = creator → none; audit row.
  - rights: Sales Rep cannot create on a lead assigned to someone else (403/404); manager rep sees the project in list/tiles/nav count and may PATCH; lead stays 404 for them (Review Focus 1).
  - convert: non-Accepted → 409 "Only an accepted quotation can become a project."; Accepted INR 1,00,000 + 18 % → value 100000.00 INR, name = subject, manager = quotation owner, quotation history "Converted to project PRJ-n", lead timeline "Converted to project PRJ-n" detail "From accepted quotation Q-…"; second call returns the same project, still one row (Review Focus 2).
  - link: linking a Draft quotation → 400; swapping quotation on PATCH clears the old link, history "Unlinked from project PRJ-n" / "Linked to project PRJ-n" (Review Focus 3); value unchanged by linking.
  - edit: companyId ignored/refused; leadId must be a visible lead of the same client; status → Completed sets completedAt, → Active clears it; stale updatedAt → 409.
  - list: tiles totals per currency, completedThisYear counts only current-year completedAt; filters by company/status.
- [ ] Run; expect FAIL.
- [ ] Implement visibility, service (transactions for create/convert/link; P2002 on quotation unique → return existing for convert), routes, nav count, quotation detail field.
- [ ] Run API tests; expect PASS.
- [ ] Commit `feat(projects): API — list, create, edit, convert, link quotation, nav count`.

### Task 3: Project-tagged email (API)

**Files:** `apps/api/src/mail/outgoing.ts` (`projectId?: number | null` stored on the message, checked visible to the sender and same company as the lead/company given), `apps/api/src/routes/mail.ts` (`POST /mail` accepts `projectId`; `GET /mail?project=` filter; `GET /mail/meta` returns `projects` the user can see `{ id, number, name, companyId }`), `apps/api/src/routes/leadEmails.ts` (accepts `projectId`), the sync path that stores replies: a synced message in a conversation whose earlier message of the same user carries a project inherits it, tests in `apps/api/test/mail.test.ts`, `apps/api/test/leadEmails.test.ts`, `apps/api/test/syncMailbox.test.ts`.

**Interfaces — Consumes:** Task 2 `projectWhere`. **Produces:** `projectId` on mail list items; query `project`.

- [ ] Write failing tests: send with projectId stores it; a project the sender cannot see → 400; `?project=` returns only the caller's own messages even when another user emailed the same project (Review Focus 5); reply synced into the same conversation inherits the project; meta lists visible projects.
- [ ] Run; FAIL. Implement. Run; PASS.
- [ ] Commit `feat(mail): project tag on sent mail, Project filter, replies inherit`.

### Task 4: Projects page, dialog, sidebar (web)

**Files:** `apps/web/src/api/projects.ts` (hooks `useProjects`, `useCompanyProjects`, `useProjectFormOptions`, `useCreateProject`, `useUpdateProject`, `useConvertQuotation`), `apps/web/src/pages/projects/ProjectsPage.tsx`, `apps/web/src/pages/projects/ProjectModal.tsx` (exported `ProjectModal({ preset?: { companyId?, leadId?, name?, value?, currency?, quotationId? }, existing?: ProjectRow, onClose })`), `apps/web/src/router.tsx` (`/projects`), `apps/web/src/components/Sidebar.tsx` (Projects after Quotations, prototype icon `tasks`, badge = nav count), locales; tests `apps/web/test/projects.test.tsx`, e2e `apps/web/e2e/projects.spec.ts`.

Copy exactly from `views-projects.js`: topbar title/subtitle and buttons, tile labels/subs ("n clients", "across all projects", "this year"), filter chips "Client: all" / "Status: any" / "✕ Clear" / "n projects", column headers, row Email/Edit buttons, empty text; dialog labels, placeholders, hint "(copied on every project email)", "No contacts at this client yet. Add contacts on the company profile.", toasts. Client options "· client"; name prefill "<company> · "; Client disabled on edit; the client select re-renders leads/quotations/contacts and stakeholder ticks on change. Value shown without ".00" like the prototype; money via shared `formatMoney`.

- [ ] Write failing component tests: tiles and rows render from a fixture; filters write `?company=&status=`; dialog validation toasts; create preset with lead pre-ticks lead contact + primary/Decision Maker; edit disables Client; 409 shows the app's stale toast.
- [ ] Run; FAIL. Implement. Run; PASS.
- [ ] e2e: create a project from the list for a client; edit status to On hold; tiles update.
- [ ] Commit `feat(web): Projects page, Create/Edit project dialog, sidebar entry`.

### Task 5: Projects on lead, company and quotation screens (web)

**Files:** `apps/web/src/pages/projects/ProjectsCard.tsx` (prototype V.projectsCard: `ProjectsCard({ companyId, leadId? })`), `apps/web/src/pages/leads/SideColumn.tsx` (replace placeholder), `apps/web/src/pages/leads/CloseLeadModal.tsx` (Won: prototype text "… A client can have several projects, so the project is created as a separate step." and third button "Mark Won and create project" → Won then open `ProjectModal` preset), `apps/web/src/pages/companies/CompanyProfile.tsx` + new `tabs/ProjectsTab.tsx` (tab "Projects" with count between Leads & Prospects and Activities; table, "+ Create project" when client, side card "How projects work" with the prototype's three bullets), `tabs/OverviewTab.tsx` (real card replaces `PlaceholderCard`), `tabs/LeadsTab.tsx` (real count), `apps/web/src/pages/quotations/QuotationEditor.tsx` (Convert to project enabled on Accepted + no project + canEdit → toast "Project PRJ-n created from Q-…"; when linked show the project "PRJ-n · <name>" linking to `/projects?company=…`), locales; tests `apps/web/test/sideColumn.test.tsx`, `apps/web/test/quotationEditor.test.tsx`, new `apps/web/test/companyProjects.test.tsx`, e2e in `apps/web/e2e/projects.spec.ts`.

- [ ] Write failing tests: card shows unlock hint for a non-client and "+ Create project" for a client; rows from this lead highlighted; Won modal third button marks Won then opens the dialog with the lead preset; company tab count and empty texts (client / not client); Convert button enabled only when Accepted without project and becomes the project link after success.
- [ ] Run; FAIL. Implement. Run; PASS.
- [ ] e2e: accept a quotation → Convert → project listed with net value; lead page card shows it; company Projects tab shows it.
- [ ] Commit `feat(web): Projects card, company Projects tab, Mark Won and create project, Convert to project`.

### Task 6: Project picker in email (web)

**Files:** `apps/web/src/pages/email/ComposeModal.tsx` (Project select enabled once a client is chosen: "— no project —" / "no projects yet" / "choose client first"; choosing one fills Lead if empty and sets Cc to the project's stakeholders with email, excluding To; "Context saved on" line adds the project name; sends `projectId`), `apps/web/src/pages/email/EmailPage.tsx` (Project filter from `/mail/meta` projects narrowed by client; choosing sets `company` and `project` in the URL; `?compose=1&company=&lead=&project=` opens Compose preset), `apps/web/src/pages/leads/EmailForm.tsx` (Project select: enabled when the company is a client, "— no project —" / "no projects yet" / "available once the lead is Won"; default the project from this lead; switching adds the new project's stakeholders to the Cc ticks and removes the previous project's, keeping hand-added ones; sends `projectId`), `apps/web/src/api/mail.ts`, locales; tests `apps/web/test/emailPage.test.tsx`, new `apps/web/test/composeProject.test.tsx`, `apps/web/test/leadPage.test.tsx`.

- [ ] Write failing tests: Compose project → Cc = stakeholders minus To, no-email stakeholder skipped (Review Focus 4); URL preset opens Compose with project; Email filter sets URL and passes `project`; lead form switch keeps a hand-added Cc and swaps project stakeholders.
- [ ] Run; FAIL. Implement. Run; PASS.
- [ ] Commit `feat(web): Project picker in Compose and lead email form, Email Project filter`.

### Task 7: Visual parity, pending list, full verification

**Files:** `apps/web/e2e/parity/projects.spec.ts` (prototype via file:// as the other parity specs), `docs/PENDING.md` (3B section: deviations kept, owner to-dos), screenshots copied to `~/Documents/DAIT-CRM/parity-screenshots-3b-projects/`.

- [ ] Capture app vs prototype: Projects list (with data and empty), Create and Edit dialog, company Projects tab and Overview card, lead Projects card (client / not client), Won dialog, quotation editor after Convert, Compose with a project, Email Project filter, sidebar.
- [ ] Compare side by side; fix every difference or list it in PENDING with the reason; write `parity-report.md` in the screenshot folder.
- [ ] Full run: `npm run build`, `TZ=Europe/London npm test`, e2e suite, `npm run i18n:check`, Prisma drift — all green.
- [ ] Commit `test(parity): projects screens match the prototype; pending list`.
