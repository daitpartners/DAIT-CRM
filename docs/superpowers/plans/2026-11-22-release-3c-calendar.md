# Release 3C — Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prototype Calendar page: the user's follow-ups, calls and meetings (timed tasks) plus a private copy of their own Outlook calendar; administrators can add the team's CRM tasks.

**Architecture:** `tasks` gains `kind`, `due_time`, `duration_minutes`; a new private `calendar_events` table filled by a `sync_calendar` worker job (Graph calendarView delta, like `sync_mailbox`); `GET /calendar` merges both for a date range; web `pages/calendar/*` matches `prototype/js/views-calendar.js`.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, Microsoft Graph (delegated, `Calendars.ReadWrite` already consented), React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-release-3c-calendar-design.md`

## Global Constraints

- Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`); `TZ=Europe/London npm test`; e2e after `npm run build`; Prisma drift check empty; `npm run i18n:check` clean (en/es/fr).
- Privacy (owner): a user's Outlook events are readable only by that user, administrators included; never on lead timeline, Tasks page, dashboard, reports or another user's calendar.
- Nothing is written to Outlook; no invitation or email is sent by anything in this release.
- Everyone toggle: role `Administrator` only (server-enforced); it adds other users' CRM tasks (under `taskWhere`), never their Outlook events.
- Task kinds `followup` | `call` | `meeting`; time `HH:MM` required for call and meeting; durations call 30, meeting 60; times stored as entered (assignee wall clock).
- Outlook window 30 days back to 180 days ahead; sync every 5 minutes; full restart once a day.
- Screens match the prototype; the final task is a screenshot parity check.
- No new npm dependencies. Never push or deploy without the owner saying "deploy".

## Review Focus

1. An administrator calls `GET /calendar?who=all` → sees team tasks but zero Outlook events of other users; a Sales Representative with `who=all` gets only their own.
2. Sync calendar switched off or mailbox disconnected → that user's copied events are gone at once, and a later sync job for it is a no-op.
3. An Outlook meeting whose attendee matches a contact on a lead the viewer can no longer see → shown without the lead link.
4. A call created at 23:30 by a user in Asia/Kolkata → shows 23:30 on that date for everyone (no time-zone shift).
5. Changing a task's type to Call without a time → 400; to Follow-up → time kept optional, duration cleared.

---

### Task 1: Timed tasks (data + API)

**Files:** `prisma/schema.prisma` + migration `prisma/migrations/20261201100000_task_kind_time/`, `packages/shared/src/leads.ts` (`TASK_KINDS`), `packages/shared/src/schemas/task.ts`, `apps/api/src/routes/tasks.ts`, task row serialiser in that file; tests `apps/api/test/tasks.test.ts`, `packages/shared/test/` (task schema).

**Interfaces — Produces:**
- `TASK_KINDS = ['followup', 'call', 'meeting'] as const`, `TaskKind`; `TASK_DURATION: Record<'call'|'meeting', number> = { call: 30, meeting: 60 }`.
- `Task.kind String @default("followup")`, `Task.dueTime String? @db.VarChar(5)` (`due_time`), `Task.durationMinutes Int?` (`duration_minutes`).
- `TaskCreate` + `kind?: TaskKind` (default followup), `dueTime?: string` (`/^([01]\d|2[0-3]):[0-5]\d$/`), `timeline?: boolean`; refine: call/meeting need `dueTime`.
- `TaskUpdate` + `kind?`, `dueTime?: string | null`; server rule on the merged result: call/meeting need a time (400 `time_required`); kind → call/meeting sets duration 30/60, → followup sets null.
- Task rows returned by `/tasks` endpoints gain `kind`, `dueTime`, `durationMinutes`.
- With `timeline: true` and a lead, create writes a lead activity: followup → `activityType 'note'`, title `Follow-up planned · <title>`, body `<YYYY-MM-DD>[ <HH:MM>] · <assignee name>`; call/meeting → `activityType 'meeting'`, title `Call scheduled · <title>` / `Meeting scheduled · <title>`, body `<YYYY-MM-DD> <start>–<end> · Phone|Microsoft Teams`. Without `timeline`, no activity (existing Add task unchanged).

- [ ] **Step 1: Failing tests** — create call without time → 400; create meeting 10:00 → kind meeting, dueTime '10:00', durationMinutes 60; create with `timeline: true` writes the activity texts above (end = start + duration, capped at `23:59`: call at 23:30 → body `2026-11-23 23:30–23:59 · Phone`; meeting 10:00 → `10:00–11:00 · Microsoft Teams`; follow-up with no time → `2026-11-23 · Neha Kapoor`); create without `timeline` writes none; PATCH kind→call without time on a dateless-time task → 400 `time_required`; PATCH kind→followup clears duration; snooze keeps dueTime; existing rows read `kind: 'followup', dueTime: null`.
- [ ] **Step 2:** Run `npx vitest run test/tasks.test.ts` (apps/api) — FAIL.
- [ ] **Step 3:** Implement schema, migration (default `'followup'` backfills existing rows), shared schemas, routes.
- [ ] **Step 4:** PASS; api + shared suites green; drift empty.
- [ ] **Step 5: Commit** `feat(tasks): calls and meetings as timed tasks; timeline entry when planned from the calendar`

### Task 2: Show and edit type/time on existing task screens (web)

**Files:** `apps/web/src/pages/tasks/TaskModal.tsx`, `apps/web/src/pages/tasks/TasksList.tsx`, `apps/web/src/pages/leads/FollowUpPanel.tsx`, `apps/web/src/api/tasks.ts` (or where task types live), `apps/web/src/i18n/labels.ts` (`taskKindText`), locales; tests `apps/web/test/` (task modal / tasks list tests).

**Interfaces — Consumes:** Task 1 fields and rules. **Produces:** `taskKindText(t, kind)`; `taskWhenText(t, task)` → `Call · 10:00–10:30` / `Meeting · 14:00–15:00` / `10:00` / '' for an untimed follow-up.

- [ ] **Step 1: Failing tests** — Edit task shows Type (Follow-up/Call/Meeting) and Time; choosing Call with empty time blocks save with an inline error; saving sends `kind`/`dueTime`; Tasks list and lead Open tasks show `taskWhenText` beside the title; es labels translated.
- [ ] **Step 2:** Run the web tests — FAIL.
- [ ] **Step 3:** Implement (Add task dialog unchanged; only Edit gains the fields).
- [ ] **Step 4:** PASS; web unit suite, i18n:check green.
- [ ] **Step 5: Commit** `feat(web): task type and time shown and editable`

### Task 3: Outlook calendar copy (worker)

**Files:** schema + migration `20261201110000_calendar_events`, `apps/api/src/graph/client.ts` (+ `calendarDeltaPage`, `calendarDeltaStartUrl`), `apps/api/src/jobs/types.ts`, `apps/api/src/jobs/handlers/syncCalendar.ts` (new), `apps/api/src/calendar/schedule.ts` (new, `scheduleCalendarSync`), `apps/api/src/worker.ts`, `apps/api/src/routes/mailboxes.ts` (delete events on sync-off / disconnect); tests `apps/api/test/syncCalendar.test.ts` (new), `apps/api/test/mailboxes.test.ts`.

**Interfaces — Produces:**
- Model `CalendarEvent` (`calendar_events`): `id`, `userId`, `accountId`, `graphId`, `subject`, `startsAt DateTime`, `endsAt DateTime`, `isAllDay Boolean`, `location String?`, `organizerName String?`, `organizerAddress String?`, `attendeeAddresses Json` (lowercase strings), `isOnline Boolean`, `leadId Int?`, `companyId Int?`, timestamps; `@@unique([userId, graphId])`, `@@index([userId, startsAt])`. `EmailAccount` gains `calendarSyncState Json?` and `calendarSyncAt DateTime?` (last full restart).
- `GraphClient.calendarDeltaPage(account, url): Promise<{ events: GraphEvent[]; removed: string[]; nextLink?: string; deltaLink?: string }>`; `calendarDeltaStartUrl(start: Date, end: Date): string` (`/me/calendarView/delta?startDateTime=…&endDateTime=…`, immutable ids, `Prefer: odata.maxpagesize`).
- Job `sync_calendar` `{ accountId }`; `scheduleCalendarSync(db?, now?)`: one per connected personal account with `syncCalendar` on and an active user, due 5 min after last run (same pending/failed rules as `scheduleMailSync`).
- Handler: no-op unless connected + syncCalendar + active user; restart from scratch when no link or `calendarSyncAt` older than 24 h (delete the account's rows outside the new window); window now−30d … now+180d; store/update by graphId, delete removed and `isCancelled`; lead link via `matchMail(db, user, { threadId: null, counterparts: attendees (not own), ownAddress })` keeping only `leadId`/`companyId`; auth failure → account `error` like mail sync; page cap and "more" re-queue like `syncMailbox`.
- Mailboxes: PATCH options with `syncCalendar: false` and POST disconnect delete that account's `calendar_events` and clear its calendar state.

- [ ] **Step 1: Failing tests** (fake Graph) — first run stores events in window with UTC times, all-day flag, attendees lowercase; second run applies removals and cancelled; attendee matches a contact on a visible open lead → leadId set; hidden lead → null; switching sync off deletes rows; disconnect deletes rows; deactivated user → nothing queued; `isAuthFailure` → account status `error`; run older than 24 h restarts and prunes out-of-window rows.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; worker types list + handler map + scheduler in the existing `schedule()`.
- [ ] **Step 4:** PASS; api suite green; drift empty.
- [ ] **Step 5: Commit** `feat(calendar): private copy of each user's Outlook calendar, synced every 5 minutes`

### Task 4: Calendar API

**Files:** `apps/api/src/routes/calendar.ts` (new, registered beside other routes), `packages/shared/src/schemas/calendar.ts` (new, exported), tests `apps/api/test/calendar.test.ts`.

**Interfaces — Produces:** `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&who=mine|all` (max 62 days; `requireUser`) →
`{ items: CalendarItem[]; overdue: CalendarItem[]; outlook: { syncOn: boolean } }` where
`CalendarItem = { kind: 'task' | 'event'; id: number; date: 'YYYY-MM-DD'; time: string | null; end: string | null; title: string; type: 'followup'|'call'|'meeting'|'internal'; done: boolean; overdue: boolean; leadId: number | null; leadNumber: string | null; company: string | null; ownerId: number; ownerName: string; where: string | null; organizer?: string | null; attendees?: string[] }`.
- Tasks: `taskWhere(user)` ∩ (who=all && Administrator ? all assignees : `assignedToId = user.id`), due date in range; `time`/`end` from dueTime + duration; `where` "Phone" (call) / "Microsoft Teams" (meeting).
- Events: only `userId = user.id` always; dates/times converted to the user's time zone (`user.timezone`); all-day → time null; `type` `meeting` if any attendee domain ≠ own mailbox domain else `internal`; lead link re-checked with `canSeeLead` (hidden → leadId/leadNumber null).
- `overdue`: open tasks with due date < today (user tz) under the same who-scope, any date.
- Sorted by date, then time (untimed last), then title (prototype).

- [ ] **Step 1: Failing tests** — mine vs all for Administrator vs Sales Representative (who=all ignored); another user's events never returned (even to Administrator); event time converted to viewer tz (Kolkata); all-day event; hidden lead link dropped; range > 62 days → 400; overdue list scope; ordering.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; api suite green.
- [ ] **Step 5: Commit** `feat(calendar): calendar API merging tasks and the user's own Outlook events`

### Task 5: Calendar page (web)

**Files:** `apps/web/src/pages/calendar/CalendarPage.tsx`, `apps/web/src/pages/calendar/NewFollowUpModal.tsx`, `apps/web/src/pages/calendar/EventInfoModal.tsx`, `apps/web/src/pages/calendar/dates.ts` (pure date helpers), `apps/web/src/api/calendar.ts`, `apps/web/src/router.tsx` (`/calendar`), `apps/web/src/components/Sidebar.tsx` (Calendar entry after Mailer, icon `cal`, no badge), `apps/web/src/styles/app.css` (calendar CSS ported from `prototype/css/app.css` `.ccal`/`.cgrid`/`.cit`… rules), locales; tests `apps/web/test/calendar.test.tsx`, `apps/web/test/calendarDates.test.ts`, e2e `apps/web/e2e/calendar.spec.ts`.

**Interfaces — Consumes:** Task 4 `GET /calendar`, Task 1 `POST /tasks` with `kind`, `dueTime`, `timeline: true`.

Behaviour = prototype `V.calendar` exactly: URL `?view=day|week|month&d=YYYY-MM-DD&who=all`; Monday-first; Month grid 5 or 6 weeks, max 3 chips + "+n more" → Day; Week 7 tall columns ("—" when empty); Day full chips (`company · lead number`); mini month (has-open dot, today, selected), Overdue box; title formats; "n open item(s) in this <view>. Click an empty slot…"; legend; topbar subtitle + "Outlook sync on" badge when `outlook.syncOn`; Mine/Everyone only for Administrators. Chips: lead → `/leads/:id`; event without lead → EventInfoModal (When, Type, Organiser, Attendees, Where, Close). Empty-day click and "New follow-up" open NewFollowUpModal (fields and validation messages as prototype: "Choose a lead", "Say what needs doing", "Choose a date", "A call needs a time"; lead select = existing searchable `Combobox` with server search over open, non-archived visible leads; Assigned to default me, list = users the existing task rules allow); save → toast `Follow-up added for Mon 23 Nov` / `Call added …` / `Meeting added …`, refetch.

- [ ] **Step 1: Failing tests** — dates helpers (grid start Monday, 5 vs 6 weeks, week title across months, dow in UTC); page renders month with chips from a stubbed API, "+n more" link, overdue box; Everyone toggle hidden for a Sales Representative, shown for Administrator and sets `who=all`; empty-day click opens the dialog with that date; call without time shows the prototype message; save posts `{ kind, dueTime, timeline: true }`; event chip without lead opens the info dialog; es strings.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** PASS; web unit, i18n:check, build, `calendar.spec.ts` (create a call from an empty day; it appears on the lead's timeline and on Tasks) green.
- [ ] **Step 5: Commit** `feat(web): Calendar page as the prototype (month, week, day, new follow-up, Everyone for administrators)`

### Task 6: Visual parity check + pending list + full verification

**Files:** `apps/web/e2e/parity/calendar.spec.ts` (new capture spec, like `parity/mail.spec.ts`), `docs/PENDING.md`.

- [ ] **Step 1:** Capture app vs prototype at 1440×900 into `/Users/mac/Documents/DAIT-CRM/parity-screenshots-3c-calendar/`: month, week, day, New follow-up dialog (each type), info dialog, Everyone (administrator), Edit task with Type/Time, lead timeline entry. Compare each pair; fix every GAP in the code (approved deviations: Edit task Type/Time; real data); re-capture until matched. Write `parity-report.md` beside the images.
- [ ] **Step 2:** Update `docs/PENDING.md` (3C status, owner decisions recorded, any listed deviations).
- [ ] **Step 3:** `TZ=Europe/London npm test`, build, full e2e, i18n:check, drift — all green; note counts.
- [ ] **Step 4: Commit** `docs: release 3C calendar done` (+ any parity fixes as their own `fix(web): …` commits).
