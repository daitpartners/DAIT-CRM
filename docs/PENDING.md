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

## Release 3A — Quotations (22 Nov 2026) — ready on `release-3a-quotations`, not merged, not deployed
- **Status:** branch `release-3a-quotations` (from main `4e14d50`), all tasks done and checked side by side against the
  prototype (screenshots in `parity-screenshots-3a-quotations/` next to the repo); unit, API, e2e, build, translations
  and database checks green. One database migration (`20261202100000_quotations`) and one new library (pdfkit, draws
  the PDF on the server). Needs merge + "deploy" from the owner.
- **Before deploying:** on live, `SELECT count(*) FROM tasks WHERE quotation_id IS NOT NULL` must be 0 (the migration
  reshapes that link).
- **What it adds:** the Quotations list (tiles, tabs, search), the quotation editor (lines with live totals, autosave,
  revisions, status, history), Preview PDF, Send by email with the PDF attached (from your own mailbox), Duplicate,
  Mark accepted / rejected / Negotiating, automatic Expired after the valid-until date, New quotation from the list and
  from the company page, the Quotation column and open quotation value on the company's Leads tab, the dashboard tile
  "Quotes awaiting response", and Settings → Company details (Administrators).
- **Owner decisions recorded:** currencies USD, CAD and INR only (India → INR, Canada → CAD, everyone else USD); GST
  18 % on INR and 0 % on USD and CAD by default, one "GST" line; issuer DAIT Partners LLP, D-303, Sagar Sadan, IP
  Extension, Delhi 110092, India, info@daitpartners.com; the PDF is drawn on the server (pdfkit), no browser needed.
- **Builder's calls (from the design):** a quotation counts as sent only when Microsoft confirms the email (until then
  it shows "Sending…" and cannot be edited; a failed send changes nothing and tells the owner and whoever sent it); after sending, any edit
  to what the PDF prints opens the next revision, and sending again without edits re-sends the same revision; list,
  tiles, dashboard and company figures use the last sent revision while a new one is unsent, and accepting or rejecting
  then discards the unsent edit after a warning; changing the currency resets GST to that currency's default (you can
  still change it); New quotation from the list asks for the company (and lead) first; accepting without a lead still
  makes the company a Client; Duplicate keeps the overall discount (the prototype drops it); rejecting never changes
  the lead's status.
- **Owner to do:** fill in the GSTIN in Settings → Company details (printed only on INR quotations); tell us if the
  accountant wants GST split into CGST / SGST (later, one line for now); Convert to project arrives with release 3B
  (the button is there but greyed out).
- **Email pagination (owner request, 22 Nov):** the Email message list now has the same pager as Leads (Rows 25 / 50 /
  100, First / Prev / page box / Next / Last, 50 per page by default). In the narrow message column it wraps onto three
  lines; search results count at most 2,000 messages.
- **Differences from the prototype (accepted):** "GST" instead of "Tax"; Convert to project greyed out until 3B; the
  send dialog has a Message box; the PDF dialog shows the real PDF with Download (instead of Print); New quotation from
  the list opens a small dialog (the prototype creates one for the first company straight away); the Email pager.
- **Fixed in the final check:** the editor button is "Negotiating" as in the prototype and saves your typing first;
  a save that fails for another reason (connection, server) keeps what you typed on screen and says so, instead of
  reloading over it; changing the currency shows the GST from Company details at once; leaving a quotation with an
  empty subject or item now warns that those edits were not saved; the PDF prints plain amounts with the currency once
  on "Total INR", as the prototype's preview. Final review: the test deploy now packs the PDF logo
  (`apps/api/assets`); Preview / Download of a sent revision with no edits shows that revision exactly as a send would
  attach it; the send dialog's default message is in the quotation owner's language (as the PDF); Send is refused
  ("someone else changed this record") if the quotation changed after the dialog opened; a failed send is reported to
  the sender as well as the owner; the total including GST is capped so a sent revision can always be recorded; a
  discard on accept / reject brings back the sent contact only if it is still active.
- **Follow-ups (not fixed):**
  - The PDF uses Helvetica (not Montserrat), always prints dates as "22 Nov 2026", and shows characters outside
    Western European letters as "?"; a very long item name with a discount can run over; a line taller than a page is
    cut to one page. PDF wording follows the quotation owner's language but is not in the translation check.
  - Changing the quotation date into another year keeps the old number (Q-2026-… stays). Valid until is not checked
    against the quotation date.
  - Accepting writes two similar lines on the lead timeline. Quotation history lines are in English only.
  - Clearing the lead on a quotation can hide it from a sales representative who could see it only through that lead
    (they are told it was saved).
  - If the database is down for the whole last send attempt, the quotation can stay on "Sending…" until an
    administrator retries the job. A re-send uses today's logo from Company details.
  - The Quotations list is not paged (fine at today's numbers); search is by the URL `?q=` and also matches the legal
    name; New quotation is offered on a closed company.
  - Email pager: changing Rows does not scroll back to the top; an invalid `?size=` stays in the address bar.
  - Pre-existing (not 3A): on the company Leads tab the lead number is dark text, not a purple link as in the
    prototype (the whole row opens the lead).

## Release 3B — Projects (22 Nov 2026) — ready on `release-3b-projects`, not merged, not deployed
- **Status:** branch `release-3b-projects` (from main `436dc98`), all seven tasks done and checked side by side against
  the prototype (screenshots and `parity-report.md` in `parity-screenshots-3b-projects/` next to the repo); unit, API,
  e2e, build, translations and database checks green. One database migration (`20261203100000_projects`). Needs merge
  + "deploy" from the owner.
- **What it adds:** the Projects page (tiles, Client / Status filters, Email a project, Create project) and the Create /
  Edit project dialog; "Projects" in the sidebar after Quotations; the Projects card on the lead page and the company
  Overview; the company Projects tab ("How projects work"); "Mark Won and create project" in the Won confirmation;
  Convert to project on an accepted quotation (value = net before GST), which then shows the green "Project PRJ-n"
  badge; a Project picker in Compose and in the lead page email form (stakeholders copied), the Project filter on the
  Email screen, and the project tag on sent mail and its replies.
- **Fixed in the parity check:** the converted quotation showed "PRJ-n · name" as a purple link; it is now the
  prototype's green "Project PRJ-n" badge (still a link to the client's projects). The Email screen's client filter and
  the Compose Client picker now mark clients "name · client" as the prototype.
- **Owner decisions (23 Nov 2026):**
  - Owner decided 23 Nov: legal name where set, as the prototype — the Projects list (Client column and filter), the
    Create / Edit project dialog, the Email screen's client filter and the Compose Client picker show the company's
    legal name when one is set, else its name (Leads and Quotations unchanged).
  - Owner OK'd 23 Nov: a project manager sees the client's contacts in the project dialog.
- **Final-review fixes (23 Nov 2026):** a stale Edit project save now closes the dialog (reopen to load the fresh row);
  the locked Client field keeps normal text; the Email Project filter ends with an ellipsis and a Lead change drops it;
  clear messages for "not accepted", "quotation already linked to another project" and an unusable project on an email;
  the quotation page names its project only to users who can see it; Edit project keeps deactivated stakeholders on
  offer; the dialog's choices load for a rep whose only way in is an archived lead.
- **Kept different from the prototype (please confirm):**
  - The lead page Status is a select (decided earlier); picking Won opens the prototype's "Mark LD-… as Won?"
    confirmation from its stepper. (The prototype's own Status select on the new lead page marks Won at once, without
    the confirmation.)
- **Found during the check, older than 3B (not changed):**
  - The lead page's "Coming up" card lists only follow-ups, calls and meetings; the prototype also lists the lead's
    quotations ("Q-2026-038 · EUR 57,120.00 · Accepted") — release 3A.
  - On the Email screen the prototype shows a quotation chip (Q-…) on mail about a quotation; the app's mail has no
    quotation tag — release 2B-2 / 3A.
- **Owner to do:** nothing new for 3B beyond merge + "deploy".

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
