# Release 3C — Calendar (design)

Owner, 22 Nov 2026: release 3 order "C" (Calendar first, then Quotations, then Projects). On privacy: "No calendar
should be own. But if admin wants to see others task for today for the visibility that should be included." On CRM
calls/meetings: option 1 — "stay in the CRM only" (nothing written to Outlook, no invitations). Approach "A". Standing
rules: screens match `prototype/index.html` (`views-calendar.js` V.calendar, calendar CSS in `prototype/css/app.css`),
checked by side-by-side screenshots before "done"; build only what the prototype shows; mail and calendar are private
to their owner, administrators included.

## Intent

One place where a salesperson sees their day: lead follow-ups, calls and meetings they planned in the CRM, and their own
Outlook meetings. Administrators can also see the team's CRM follow-ups and tasks (for example "what is everyone doing
today") — never anyone's Outlook calendar.

## Goals / non-goals / anti-goals

- Goals: the prototype Calendar page (mini month, Overdue list, Day / Week / Month, New follow-up dialog, item info,
  legend, Mine / Everyone); calls and meetings as timed tasks; a private read-only copy of each user's Outlook calendar
  shown only on their own calendar; the sidebar Calendar entry enabled.
- Non-goals: writing anything to Outlook; meeting invitations or Teams links; editing or deleting Outlook events from the
  CRM; drag-and-drop rescheduling; shared/team Outlook calendars; reminders/notifications for calendar items beyond what
  tasks already do; reports changes.
- Anti-goals: anyone seeing another person's Outlook events (titles, times, attendees, "busy" blocks) — administrators
  included; an invitation or email reaching a client because of the calendar; a call/meeting that is missing from the
  Tasks page, overdue counts or the lead timeline while it shows on the calendar.

## Approaches

1. **Chosen (owner "A"):** calls and meetings are tasks with a type and a time; Outlook events are copied every 5
   minutes by the worker into a private table, like mail sync (release 2B-2).
2. A separate calendar table for CRM calls/meetings — rejected: they would be missing from Tasks, overdue counts and the
   dashboard unless each were changed; two lists of to-dos that can disagree.
3. Reading Outlook live on each calendar view — rejected: every navigation waits on Microsoft, no lead linking, fails
   when Graph is slow.

## Decided

**Who sees what.**
- Everyone sees their own calendar: their tasks (all types) and their own Outlook events.
- The **Mine / Everyone** toggle is shown to **Administrators** only. Everyone = all users' CRM tasks (follow-ups,
  calls, meetings) the administrator can see under the existing task rules, plus the administrator's own Outlook
  events. Other users' Outlook events never appear. Non-administrators never see the toggle; `?who=all` is ignored for
  them (server enforces).
- The Overdue list follows the toggle (own overdue tasks; in Everyone, the team's).

**Calls and meetings are tasks (data change).** `tasks` gains:
- `kind` — `followup` (default, existing rows) | `call` | `meeting`;
- `due_time` — optional wall-clock time `HH:MM` (follow-ups optional, calls and meetings required);
- `duration_minutes` — optional; set on create: call 30, meeting 60 (prototype); shown as start–end.
Times are the assignee's local wall-clock time, stored as entered (like `due_date`, no time-zone shift); everyone sees
them as entered. Overdue stays date-based (due date before today, not done), as today.
Calls and meetings appear wherever tasks do: Tasks page, lead timeline/follow-up, overdue counts, dashboard tile —
showing their type and time. Existing task rights apply unchanged (who may create, edit, complete, reassign).

**New follow-up dialog (prototype).** Lead (required; open, non-archived leads the user can see; searchable), What to do
(required), Type (Follow-up / Call / Meeting), Date (required), Time (required for Call and Meeting), Assigned to
(default me; the same assignment rule as existing task creation). Opened by the "New follow-up" button (today in Month
view if this month, else the shown day) and by clicking an empty day/slot (that day). Saved as a task with origin
`manual`; nothing is sent anywhere. As the prototype (`store.js` createFollowUp / createEvent), saving also writes a
lead timeline entry: "Follow-up planned · <title>" (date, time, assignee), "Call scheduled · <title>" or "Meeting
scheduled · <title>" (date, start–end, where). Completing or rescheduling writes nothing new (as today). The existing
Add task dialogs keep their current behaviour.

**Correcting a call or meeting (owner: option 1, 22 Nov 2026 — a deliberate addition beyond the prototype).** The
existing Edit task dialog (Tasks page and lead page) gains Type and Time. The server requires a time whenever the type is
Call or Meeting; changing the type to Call or Meeting sets the duration to 30 / 60 minutes, to Follow-up clears it.
Editing writes no timeline entry (as today). Same edit rights as today. Toast as prototype ("Call added for Mon 23 Nov"). Where: shown as "Phone" for a
call and "Microsoft Teams" for a meeting only as the prototype's display text — no link is created.

**Outlook copy (private).**
- Uses the existing per-mailbox **Sync calendar** switch (Settings → Email & calendar connections, `sync_calendar`) on a
  connected personal mailbox. Off or disconnected → that user's copied events are deleted.
- Worker job `sync_calendar` per account, every 5 minutes (same scheduler pattern as `sync_mailbox`); Graph
  `calendarView` delta over a rolling window **30 days back to 180 days ahead**; recurring meetings arrive as single
  occurrences; cancelled and removed events are deleted. The existing token/connection handling, error status
  ("needs reconnecting") and stale-job rules apply.
- Table `calendar_events` (owner `user_id`, `account_id`, Graph id, subject, start/end (UTC), all-day flag, location,
  organiser name/address, attendee addresses, `is_online`, optional `lead_id`/`company_id`). Every read is filtered by
  the caller's own `user_id`, whatever their role. Never on the lead timeline, Tasks page, dashboard or reports.
- Lead link: an attendee address matching a contact's business email links the event to that contact's open lead the
  user can see (same matching rules as mail, `mail/match.ts`); no link otherwise.
- Shown in the viewer's own time zone. Type for the chip/legend: `meeting` if any attendee is outside the user's own
  email domain, else `internal` (prototype legend "Internal").

**Calendar page (prototype V.calendar).** Top bar "Calendar · Follow-ups, calls and meetings for your leads", plus the
"Outlook sync on" badge when the user's sync is on; Mine/Everyone (administrators). Left: mini month (days with open
items marked), Overdue list (tasks only). Right: New follow-up, Today, ‹ ›, title, Day/Week/Month; "n open items in
this <view>. Click an empty slot…"; Month grid (up to 3 chips per day, "+n more" → Day view), Week (7 tall columns),
Day (full chips with company · lead number); legend. Chips: time, title; task chips and lead-linked events open the
lead; other Outlook events open the prototype info dialog (When, Type, Organiser, Attendees, Where). URL keeps view, date
and who (`/calendar?view=week&d=2026-11-23&who=all`). Done tasks shown struck through; overdue in red, as the prototype.

**Sidebar.** Calendar enabled (no badge — the prototype shows none).

**Languages.** All new text in en / es / fr.

**Builder's calls (from the builder check, marked as such).** Rescheduling/snoozing a call or meeting keeps its time.
"Internal" is judged against the domain of the synced mailbox address. A lead link on an Outlook event is re-checked
against the viewer's lead visibility when the calendar loads (hidden lead → no link). Graph calendar delta keeps the
window it started with, so the sync restarts from scratch once a day to roll the 30/180-day window. The Everyone toggle
is Administrators only, as the owner said, even though Managers see all tasks on the Tasks page.

## Left to the builder

API shapes, file layout, how the calendar range query is paged, Graph delta details and page caps (follow
`syncMailbox`), which existing task screens need a small change to show type/time, empty/loading states consistent with
the app, tests. Before calling it done: the screenshot parity check of the Calendar page (each view, the dialog, the info
dialog, Everyone) against the prototype, differences fixed or listed for the owner.
