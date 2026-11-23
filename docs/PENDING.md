# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so. Items that were fixed are no longer listed (they are
in the git history).

## Where things stand (23 Nov 2026)

- **Everything built so far is live** at crm.daitpartners.com, release `08ee5da` (AI research with the Claude Code
  engine). The repository's `main` has one more commit, `c01e562`, which only changes the GitHub test-deploy workflow;
  nothing to deploy.
- **There is no test copy on the server.** Each release was checked on the developer's machine (automatic tests and
  side-by-side screenshots against the prototype) and then put live by hand, only after you said "deploy". How that is
  done, and how to undo it, is in `docs/DEPLOYMENT.md`.
- **Backups:** a copy of the database is taken before every deploy, in `/home/daitcrm/backups/` on the server.
- **Handover documents:** `docs/DEPLOYMENT.md` (server, deploy, rollback, backup and restore, logs),
  `docs/MIGRATIONS.md` (database changes), `docs/ENVIRONMENT.md` (server settings), `docs/data-model.md` (tables), and
  `docs/DAIT-CRM-Specification-v2.md` (the specification, marked with what was built, built differently or not built).

| Release | What it added | Live as |
|---|---|---|
| 1A, 1B, 1C, prototype parity | Sign-in, users, settings; Companies and Contacts; Leads, Prospects and Tasks; screens matching the prototype | live 21 Nov (1B `2f8f310`, parity gaps `f869dda`) |
| Leads exact-match | Lead page as the prototype, Profile card | `8236e97` |
| Experience on every lead | Experience section on every lead | `54a2040` |
| 1E Reports | Reports page as the prototype | `baff803` |
| 2A | Personal mailbox connections, email templates | `7d695e6` |
| Outreach language | English / Español on leads, allocation by language | `b97aa6c` |
| 2B-1 | Send email from the lead page through your own mailbox | `ccfb2b4` |
| 2B-2 | Mail sync and the Email screen | `8b1a8d9` |
| 2C | Mailer | `4bb3601` |
| Mail follow-ups | Fixes to Email and Mailer, prototype look, Email reader crash fix | `2d4e618` |
| 3C | Calendar | `efaf872` |
| 3A | Quotations, Email pager | `436dc98` |
| 3B | Projects | `2c14c1c` |
| 4 | AI research (Claude off) | `fa12206` |
| Claude Code engine | Claude through the server's Claude Code, monthly run cap | `08ee5da` |

## Owner to do

- **GSTIN:** fill it in under Settings → Company details (printed only on INR quotations). Tell us if the accountant
  wants GST split into CGST / SGST (one "GST" line for now).
- **Calendar:** switch on "Sync calendar" for your mailbox in Settings → Email & calendar connections (and ask the team
  to do the same) so your Outlook meetings show on the CRM calendar.
- **Mailboxes:** ask Carlos, Lakshita and Sebastian to connect their mailboxes (Settings → Email & calendar
  connections).
- **Mailer test:** run a small test campaign to your own addresses (1-minute delay, Send now, working hours off) and
  check delivery, Outlook Sent Items, and Queued → Sent on the campaign page.
- **Templates:** add your email templates in English and Spanish (Settings → Email templates).
- **Countries:** add Mexico and Chile to the country list (Settings → lookup values) so Spanish-market leads can use them.
- **Claude Code (AI research):** the token is already on the server. In any company's AI Intelligence tab →
  Enrichment engine, switch Claude Code on and set a monthly run cap (runs that use Claude per calendar month). Then test
  Web search once, on one company, before relying on it.
- **Google Places (optional, paid):** needs a Google Cloud project with billing, a budget alert and a quota for the
  Places API (New), and a key restricted to the Places API set on the server as `GOOGLE_PLACES_API_KEY`; then switch
  "Google Places API" on in the engine card with a monthly call cap.
- **Apollo.io:** needs a paid Apollo plan; not built (shows "not connected").
- **Break-glass sign-in:** once everyone signs in with Microsoft, have `LOCAL_ADMIN_LOGIN` removed from the server
  settings.
- **Answer the owner decisions below.**

Good to know: the AI daily run limit (default 50 across the CRM) resets at midnight UTC (05:30 IST); the Claude monthly
run cap and the Places monthly call cap reset at midnight UTC on the 1st of the month.

Later clean-up (developer): the unused `enrichment_settings.claude_monthly_cap_usd` column can be dropped in a later
migration (`docs/MIGRATIONS.md`).

## Owner decisions (please confirm)

- **Leads bulk bar: Assign to… and Archive** are not in the prototype. Owner (22 Nov): "keep in pending list" — kept as
  built for now; decide later whether to drop them to match the prototype exactly.
- **Email reader Archive button** is not in the prototype; it was approved in the 2B-2 design. Keep or remove?
- **Edit profile dialog layout and contact line order** differ from the prototype (decided in the leads exact-match
  design). Confirm this is still wanted.
- **Mailer list shows the pause reason** ("Paused by …", "Mailbox needs reconnecting"); the prototype does not. Keep?
- **Background job clean-up:** finished jobs are now deleted after 7 days and failed jobs after 30 days (old failures
  can no longer be retried from the jobs view). OK?
- **Lead page Status** is a select (decided earlier); picking Won opens the prototype's "Mark LD-… as Won?"
  confirmation from its stepper. (The prototype's own Status select on the new lead page marks Won at once, without
  the confirmation.)

## Decided (recorded)

- Mailer daily limit stays 200 per mailbox; Mailer working hours are the client's (Mon–Fri 09:00–18:00 their time).
- Mail and the Outlook calendar stay private to their owner, administrators included. Calendar **Mine / Everyone** is
  for Administrators only; Everyone adds the team's CRM tasks, never anyone's Outlook events.
- Calls and meetings planned in the CRM stay in the CRM: nothing is written to Outlook, no invitations or emails. Edit
  task gains Type and Time (Tasks page only).
- Quotations: currencies USD, CAD and INR only (India → INR, Canada → CAD, everyone else USD); GST 18 % on INR and 0 %
  on USD and CAD by default, one "GST" line; issuer DAIT Partners LLP, D-303, Sagar Sadan, IP Extension, Delhi 110092,
  India, info@daitpartners.com; the PDF is drawn on the server.
- Projects: value = net before GST; legal name shown where set (Projects list, project dialog, Email client filter,
  Compose Client picker); a project manager sees the client's contacts in the project dialog.
- AI research: free Website reader always on; Claude through the server's Claude Code (no paid API); nothing invented,
  only empty, unverified fields get suggestions.

## Parked by the owner

- **1D public contact form + Enquiries** — "keep contact in pending, i will decide lateron" (22 Nov 2026). Open point:
  daitpartners.com/contact already has its own brief form (contact.php → Mailjet).

## Kept by design (differences from the prototype you accepted)

- Templates list filling up to six with other languages (matches the prototype).
- A lead without a contact has no way to set Do not email (matches the prototype).
- The Mailer wizard lists all templates (your language first) (matches the prototype). The campaign page links to the
  lead page, not its Email tab (matches the prototype; the lead page opens on the Email tab).
- Quotations: "GST" instead of "Tax"; the send dialog has a Message box; the PDF dialog shows the real PDF with Download
  (instead of Print); New quotation from the list opens a small dialog first; the Email pager.
- Calendar: real data instead of demo data; a CRM task without a lead opens the same details box as an Outlook event
  without a lead; the lead picker does not repeat "— choose a lead —" as its first row; the lead page "Calls" count
  counts logged calls only.
- AI research: the Enrichment engine card follows the design (Website reader; Claude Code on this server; Ollama "not
  installed on this server"; Web search needs Claude Code; Google Places off until a key and a cap; Apollo "not
  connected"; daily run limit). No AI summary, classification or opportunity score until Claude is on. The lead page
  AI line's "Run research" starts a run (the prototype's links to the AI tab).

## Open minor follow-ups

Small issues found in reviews and not fixed yet. Wording kept as recorded.

**From release 3A (Quotations):**
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

**Found during the 3B check (older than 3B, not changed):**
- The lead page's "Coming up" card lists only follow-ups, calls and meetings; the prototype also lists the lead's
  quotations ("Q-2026-038 · EUR 57,120.00 · Accepted") — release 3A.
- On the Email screen the prototype shows a quotation chip (Q-…) on mail about a quotation; the app's mail has no
  quotation tag — release 2B-2 / 3A.

**From release 3C (Calendar):**
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

**From the mail follow-ups review (Email and Mailer):**
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
