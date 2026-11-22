# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so.

## Where things stand (22 Nov 2026, end of session)
- **Live:** crm.daitpartners.com runs release `4bb3601` (2A connections + templates, 2B-1 send from lead, 2B-2 mail
  sync + Email screen, 2C Mailer). Backups on the server in `~/backups/` (`dait_crm-pre-release-2c.dump` is the latest).
- **Ready, not merged, not deployed:** branch `mail-follow-ups` holds the 2B-2 / 2C follow-ups below plus visual-parity
  fixes so Email, Compose, Link to lead, the Mailer list, the campaign page, the wizard and the Leads bulk bar match the
  prototype. Local `main` = live. Needs merge + "deploy" from the owner.
- **Owner to do:** run a small test Mailer campaign to your own addresses (1-minute delay, Send now, working hours off)
  and check delivery, Outlook Sent Items, and Queued → Sent on the campaign page; ask Carlos, Lakshita and Sebastian to
  connect their mailboxes (Settings → Email & calendar connections); add Mexico / Chile to the country list; templates
  in English and Spanish; remove LOCAL_ADMIN_LOGIN once everyone signs in with Microsoft; answer the owner decisions below.
- **Decided:** Mailer daily limit stays 200 per mailbox ("go with 200 only"); mail stays private to its owner,
  administrators included; Mailer working hours are the client's (Mon–Fri 09:00–18:00 their time).
- **Next release options:** deploy `mail-follow-ups`, the follow-ups from this round, 1D (parked), or release 3
  (calendar, quotations, projects).

## Owner decisions (please confirm)
- **Leads bulk bar: Assign to… and Archive** are not in the prototype. Owner (22 Nov): "keep in pending list" — kept as
  built for now; decide later whether to drop them to match the prototype exactly.
- **Email reader Archive button** is not in the prototype; it was approved in the 2B-2 design. Keep or remove?
- **Edit profile dialog layout and contact line order** differ from the prototype (decided in the leads exact-match
  design). Confirm this is still wanted.
- **Mailer list shows the pause reason** ("Paused by …", "Mailbox needs reconnecting"); the prototype does not. Keep?
- **Background job clean-up:** finished jobs are now deleted after 7 days and failed jobs after 30 days (old failures
  can no longer be retried from the jobs view). OK?

## Parked by the owner
- **1D public contact form + Enquiries** — "keep contact in pending, i will decide lateron" (22 Nov 2026). Open point:
  daitpartners.com/contact already has its own brief form (contact.php → Mailjet).

## Release 3C — Calendar (22 Nov 2026) — ready on `release-3c-calendar`, not merged, not deployed
- **Status:** branch `release-3c-calendar` (from main `63cd73e`), all six tasks done and checked side by side against
  the prototype; unit, API, e2e, build, translations and database checks all green. Two database migrations
  (`20261201100000_task_kind_time`, `20261201110000_calendar_events`). Needs merge + "deploy" from the owner.
- **What it adds:** the Calendar page (mini month, Overdue, Day / Week / Month, New follow-up dialog, details of an item
  without a lead, legend); calls and meetings as timed tasks (call 30 min, meeting 60 min) shown on Tasks and the lead
  page; a private copy of each user's own Outlook calendar, refreshed every 5 minutes when "Sync calendar" is on in
  Settings → Email & calendar connections.
- **Owner decisions recorded:**
  - The calendar is private: a user's Outlook events are seen only by that user, administrators included — never on
    the lead timeline, Tasks, dashboard, reports or anyone else's calendar.
  - **Mine / Everyone** is for Administrators only; Everyone adds the team's CRM tasks (follow-ups, calls, meetings),
    never anyone's Outlook events. (The prototype shows the switch to everyone.)
  - Calls and meetings planned in the CRM stay in the CRM: nothing is written to Outlook, no invitations or emails.
  - **Edit task gains Type and Time** (a deliberate addition beyond the prototype) — on the Tasks page only; the lead
    page shows the text (e.g. "Call · 10:00–10:30") and you change it on Tasks.
- **Other differences from the prototype (accepted):** real data instead of demo data; a CRM task without a lead
  opens the same details box as an Outlook event without a lead (the prototype has no such task); the lead picker's
  list does not repeat "— choose a lead —" as its first row (same as every other picker in the CRM); the lead page
  "Calls" count counts logged calls only — a planned call shows in the history but is not counted (the prototype does
  not show planned calls under Calls at all).
- **Fixed in the parity check:** "Lead *" spacing on required fields (all forms, as the prototype); the lead picker now
  starts with 25 open leads (closed ones filtered on the server); no "0 open items" / "Nothing overdue." flash while
  the calendar loads; Coming up on the lead page shows calls and meetings with the calendar icon, date and time, linking
  to that week; a done call or meeting no longer pushes its "Done" badge out of the Completed card on Tasks.
- **Fixed in the final review (22 Nov):**
  - Dashboard: "Meetings today" and "Today's agenda" now work as the prototype, from your own calls, meetings and
    timed follow-ups for today (CRM tasks only, never Outlook events); the tile shows the next one ("next at 14:00 ·
    Demo") and links to the Calendar. The calendar no longer says "release 3" (quotations still do).
  - Planning a call or meeting no longer counts as contact: it still shows on the lead timeline, but not as the lead's
    "Last contact" nor in the company's Activity summary.
  - Copied Outlook events show only while "Sync calendar" is on and the mailbox is connected (or needs reconnecting).
  - The automatic follow-up task (from the lead's follow-up date) keeps its type: Type is greyed out in Edit task and
    the server refuses a change; its time can still be set.
  - Outlook events sent in other names for UTC (Etc/UTC, GMT, Coordinated Universal Time, …) are no longer skipped.
- **Follow-ups (not fixed):**
  - All-day Outlook events may show one day off for users in UTC+12 to +14 (New Zealand, Tonga, Kiribati).
  - Check the first live Outlook sync: compare times and all-day events with Outlook for a couple of users.
  - No "plan a follow-up" link from the lead page to the calendar dialog (the prototype's `?new=1&lead=` link is not
    built); plan from the Calendar or add a task on the lead.
  - While a mailbox is in error ("needs reconnecting") its old copied Outlook events keep showing until it is fixed,
    switched off or disconnected.
  - If Microsoft sends an event change in another time zone (not UTC under any of its names), the old time shows until
    the daily full re-sync.
  - The calendar entry written on the lead timeline when a call or meeting is planned is not in the lead's audit log
    (other notes are).
  - An impossible date typed into the address bar (e.g. 31 Feb) is accepted, as in the prototype.
  - Empty calendar days cannot be reached with the keyboard (as the prototype); the New follow-up button can.
  - On narrow screens the type / time text on the lead page's open tasks can squeeze the title.
  - Administrators' Everyone view loads every overdue team task at once (fine now, slower with many users).

## Release 2B-2 follow-ups (from the final review, 22 Nov 2026; live release 8b1a8d9) — fixed on `mail-follow-ups`
- ~~Mail in a conversation can link to a lead the user can no longer see (thread match skips the visibility check); the
  list may then show that lead's number.~~ Done `63c6e57`.
- ~~A draft sent from Outlook may keep its Draft status in the CRM (status is not updated on existing rows).~~ Done `f2489c1`.
- ~~Times show the date only (list, thread history, "synced …"); the prototype shows relative times / time of day.~~
  Done `7531818`, `2ad59ce`.
- ~~After opening a message its list row stays bold for up to a minute.~~ Done `7531818`.
- ~~Background job rows are never cleaned up (~288 per mailbox per day); a deactivated user's connected mailbox gets an
  empty sync job every minute.~~ Done `f2489c1`.
- ~~Compose dialog shows untranslated lead status / source and contact type~~ — done `7531818`. The Templates list
  filling up to six with other languages — kept by design (matches the prototype).
- ~~Link-to-lead dialog falls back to "create a new lead" when a search hides the lead you had picked.~~ Done `7531818`.
- ~~Message count on a taken-over mailbox includes the previous owner's mail~~ — done `f2489c1`. ~~Awaiting reply is
  capped before filters~~ — done `63c6e57`.
- ~~Reply route swallows a database error while locking the lead (inside the transaction).~~ Done `63c6e57`.
- Visual parity (Email reader contact card, thread history, Compose, Link to lead searchable select) — done `daffce4`.

## Release 2C (Mailer) follow-ups (from the final review, 22 Nov 2026) — fixed on `mail-follow-ups`
- ~~Daily-limit day boundary is an hour off on some daylight-saving change days (e.g. Santiago, Sydney).~~ Done `eab83c5`.
- ~~Pause reason ("Paused by …", "Mailbox needs reconnecting") is shown in English for Spanish / French users.~~
  Done `246ec7b`.
- ~~The Do not email badge and tick box ignore a contact unsubscribed through another lead (the mailer still skips
  it).~~ Done `cb90c47`.
- A lead without a contact has no way to set Do not email — kept by design (matches the prototype).
- ~~Over a weekend a waiting campaign re-checks every 5 minutes (extra background work; could jump to Monday 09:00).~~
  Done `a51a424`.
- ~~If the template is deleted, the unsubscribe line falls back to English.~~ Done `a51a424`.
- ~~Time zone: a company with only a country ignores the lead's own city; some Mexican / Brazilian states are not in the
  table.~~ Done `a51a424` (lead city), `eab83c5` (all states).
- ~~Wizard still opens when none of the ticked leads can be emailed (prototype refuses with a message); more than 500
  ticked leads shows a generic error.~~ Done `246ec7b`.
- Wizard lists all templates (your language first) — kept by design (matches the prototype). ~~"Local time" shows the
  zone name, not the current time there; campaign page has no Message column~~ — done `246ec7b`. Campaign page links to
  the lead page, not its Email tab — kept by design (matches the prototype; the lead page opens on the Email tab).
- ~~The Mailer list loads every recipient of every campaign (fine now, slower later)~~ — done `3716c44`. ~~No automated
  test of two steps running at once~~ — done `a51a424`.
- ~~A mailbox put in error by mail sync pauses a campaign with "Mailbox disconnected" instead of "needs
  reconnecting".~~ Done `a51a424`.
- Visual parity (Mailer list, campaign page, wizard, Leads bulk bar with Send via mailer at the right) — done `7b7b6c5`.

## Follow-ups from this round (mail follow-ups review, 22 Nov 2026; not fixed yet unless marked)
- ~~**Important (also on live):** the Email screen crashes ("Invalid time value") when the open message's lead has a
  next follow-up date.~~ **Fixed (1fe84da, not deployed):** GET /api/mail/:id now gives `lead.nextFollowUp` as
  `YYYY-MM-DD` like the lead API, so the reader's day formatter gets a calendar date. The parity mail spec also
  re-unlinks "Website enquiry" (email.spec makes a lead from it earlier in the full run).
- A mail sync already queued still runs once after a user is deactivated (later syncs stop).
- Opening a message straight from a link (/email/…) may keep its list row bold until the list refreshes.
- Two incoming mails in a row in a thread both read "reply received".
- Your own sent message, opened, reads "sent by <your name>" instead of "sent" as in the prototype.
- Very long conversations show only the latest 50 messages.
- An older message in a linked conversation can still show as unmatched.
- The Mailer wizard closes if the Leads list refreshes and the ticked leads clear.
- A mailbox disconnected after the Leads page loaded is only refused when you press Queue in the wizard.
- Ticking Do not email on two leads of the same contact at the same moment could leave one flag unsaved (rare);
  ticking lead B when the contact is already unsubscribed does not set B's own flag.
- Mexican state codes such as JAL, NLE are not recognised (full state names are).
- Brazilian 2-letter state codes may match a city name instead and pick the wrong time zone.
- The mail list stops at 5000 messages without saying so; the company filter can match through a lead you cannot see.
- The Compose contact line "· COO · primary" is not greyed out as in the prototype; Details values wrap slightly earlier.
- Keyboard: Shift+Tab can leave an open dialog.
