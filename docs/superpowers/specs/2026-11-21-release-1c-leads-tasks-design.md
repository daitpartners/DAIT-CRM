# Release 1C — Leads & Tasks (short design)

Deepak Singh, 21 Nov 2026: "you go with your pick". Builds on the fresh-build design
(`2026-11-21-dait-crm-fresh-build-design.md` §5) and release 1B (live at crm.daitpartners.com, 2f8f310).

## Intent

The sales pipeline: Leads and Prospects worked from New to Won, with tasks, transfers and a timeline, on top of the
company master built in 1B. Success: Deepak, Carlos, Lakshita and Sebastian can run their day from the Leads list and
Tasks page.

## Goals / non-goals / anti-goals

- Goals: Leads list (tiles, tabs, filters, sort, paging, bulk assign/archive), create Lead/Prospect with live duplicate
  detection reusing 1B matching, CSV import (creates Prospects), lead page (profile box, status stepper with the
  server-side rules, Log call, follow-up, transfer with note, close with reason, switch contact, archive, timeline),
  Tasks page (today / overdue / upcoming, tick, edit, re-date, reassign), Notifications page, one lead per imported
  prospect from the 21 Nov import.
- Non-goals: enquiries and the public form (1D), dashboard/reports (1E), email/calendar/quotations (later releases),
  AI enrichment (status column only).
- Anti-goals: silent reassignment (every assignment change writes a `lead_assignments` row); overdue counts that
  include closed leads; duplicated companies from lead creation.

## Pending decisions applied

- Decision 1 (lead-page actions), Deepak accepted the builder's pick: KEEP edit details, archive (confirm),
  transfer with mandatory note, close with reason (Lost / Not Relevant require a reason text), switch contact
  (among the company's contacts). DROP clone and note-less reassign. Unassign writes an assignment row with to=null.
- Decision 4 (roles): as in the fresh-build design §5 — Administrator and Manager see all leads; Sales Representative
  sees own and unassigned (can claim); Data Research User sees prospects and own leads.
- Decision 3 (allocation rules) is configuration (Settings → Allocation rules, built in 1A); 1C applies `pickAssignee`
  on create when no assignee is given.
- Decision 5 (dropdown values): the lookup lists as seeded, extended by the 30 values the import added.

## Approaches

1. Tasks as a view over leads' follow-up dates (no table) — rejected: spec requires tasks with origin, done state and
   reassignment, and quotations add tasks later.
2. Status rules in the web — rejected: the fresh-build design puts every rule in the API.
3. **Chosen:** `leads`, `lead_activities`, `lead_assignments`, `tasks` tables per `docs/data-model.md`; one
   `applyStatusChange(tx, lead, to, byUser, reason?)` service that owns Won/closed effects, follow-up task sync and
   activity rows; routes call it from every screen; web renders.

## Decided

- Tables from `docs/data-model.md` Module 1 (ids integer; `number` `LD-` from a sequence like CO-; `archivedAt`;
  `updatedAt` concurrency; audit rows). `tasks.origin` enum as listed. `lead_activities.activityType` as listed.
- Visibility: extend `companyWhere` to OR `leads.some({ assignedToId: user.id })` (fresh-build §5); `leadWhere(user)`
  per the role split above. Row visibility in the API; hidden → 404.
- Create lead: company resolved by 1B matching (auto on domain, else candidates shown, else create company + contact);
  contact optional; `pickAssignee(country)` when unassigned; creation activity; "Review new lead" task when assigned;
  notification to the assignee.
- Status rules (spec §4.3) in `applyStatusChange`: Won → company `isClient`, `convertedTo='client'`, one
  "Converted to client" activity; Won/Lost/Not Relevant → follow-up cleared, open tasks closed with a note activity;
  Lost/Not Relevant require a reason stored in the status activity body.
- Follow-up date → upsert the open `follow-up date` task for the assignee; cleared → remove it.
- Transfer: note required, `lead_assignments` row, open tasks move, receiver notified, activity.
- Log call: outcome, minutes, note, optional status-after and next follow-up in one transaction.
- CSV import: mapping UI (column → field), creates Prospects with `importBatch`, runs company matching; a row with
  an auto-match links, review candidates are listed per row for the user to pick, else creates.
- Seed migration of the 21 Nov import: a one-off script creates one Prospect per imported company (source `CSV
  Import`, batch `IMPORT-2026-11-21`, status from Pipeline Stage: Identified/Researched → New, Contacted → Contacted,
  else New; assignee = company createdBy; priority from Lead Score if present, else Medium) from
  `leads_pending_1C.csv`. Run once on live after deploy, like the 1B import.
- Tasks page: tabs Today / Overdue / Upcoming / Done; tick, edit title/date, reassign (only to someone who can see the
  lead), snooze to tomorrow (UX M5). Notifications page: list, mark read, link.
- Carry-overs done first: `prismaErrors.ts`, `visibleCompanyIds()`, `useUrlListState`, shared form `onError`;
  test that the partial index survives; 1C migration folder named after `20261122100000`.
- Contacts: add Deactivate (isActive flag, hidden from pickers) and Move to another company (audit); `isClient`
  editable by Administrator/Manager (builder's call from the 1B final review; Deepak said "fine with your
  recommendation").
- Tests: unit on `applyStatusChange`; API on visibility, transfer, follow-up/task sync, Won rule, CSV import matching;
  e2e: create lead with duplicate link, log call → status + follow-up task, transfer, tasks page tick.

## Left to the builder

Exact Prisma fields, route shapes within 1A/1B conventions, lead list tile definitions from the prototype
(`prototype/js/views-leads.js`), CSV mapping UI details, component split.
