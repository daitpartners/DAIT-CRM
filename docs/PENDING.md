# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so. Items that were fixed are no longer listed (they are
in the git history).

## Where things stand (23 Nov 2026)

- **Live** at crm.daitpartners.com: release `79b9415` (minor fixes + handover documents, 23 Nov).
- **Ready, waiting for "deploy":** branch `ui-review-fixes` — collapsible sidebar and Email folders column, and the 39
  findings of the 23 Nov UI review (`~/Documents/DAIT-CRM/ui-review-2026-11-23/report.md`), reviewed and tested.
- **There is no test copy on the server.** Each release was checked on the developer's machine (automatic tests and
  side-by-side screenshots against the prototype) and then put live by hand, only after you said "deploy". How that is
  done, and how to undo it, is in `docs/DEPLOYMENT.md`.
- **Backups:** a copy of the database is taken before every deploy, and every night at 02:30 UTC (kept 14 days), in
  `/home/daitcrm/backups/` on the server. All copies are on that one server; a copy to OneDrive needs you to sign in
  once there (not set up).
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
| Minor fixes | 26 review follow-ups (time zones, mail linking, Mailer wizard, quotations, keyboard) + handover docs | `79b9415` |

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

Small issues found in reviews and not fixed yet.

**Need your decision (or a screen the prototype does not have):**
- Very long email conversations show only the latest 50 messages; the prototype has no way to load older ones.
- The mail list stops at 5000 messages without saying so (a notice is not in the prototype; removing the limit means
  rewriting the list).
- Quotation PDF: uses Helvetica (not Montserrat), prints dates one fixed way ("22 Nov 2026"), and shows letters outside
  Western European alphabets as "?". Fixing needs font files and a date-format choice.
- Changing a quotation's date into another year keeps the old number (Q-2026-… stays) — renumber or not?
- "Valid until" is not checked against the quotation date (the prototype does not check it).
- Clearing the lead on a quotation can hide it from a sales representative who could see it only through that lead —
  refuse, or warn?
- The Quotations list has no pages (fine at today's numbers).
- Accepting a quotation on a lead already marked Lost / Not Relevant moves it to Won without a warning (as before).
- Companies list keeps row tick boxes (they drive the bulk status change); the prototype has none — keep?

**Known, small, left as they are for now:**
- Email reader (HTML bodies, 23 Nov): pictures embedded in an email (Outlook "inline" images, `cid:`) are not fetched
  yet, so they are hidden rather than shown broken; remote pictures show, as in Outlook. A body is stored up to 50,000
  characters, so a very long newsletter is cut (still shown formatted, up to the cut). Before anything reads it, a body
  is cut to its first 1,000,000 characters and to 256 nested elements (security review 24 Nov: keeps one hostile email
  from blocking the CRM). The HTML body sits in a sandboxed
  frame that fills the reader and scrolls on its own: with no scripts and no same-origin access the CRM cannot measure
  the email to grow the frame to its height.
- Quotation stays on "Sending…" if the database is down for the whole last send attempt (an administrator retries the
  job); a re-send uses today's logo from Company details. A line taller than a page is cut to one page (as the
  prototype).
- Mail has no quotation chip (needs a link between mail and quotations in the database).
- An email that sync left unmatched stays unmatched until someone links a message in its conversation.
- A 2-letter state code typed in the city field ("TX", "ON") no longer narrows the Mailer's time zone (falls back to
  the country's zones — never wrong, just wider). "Edo. Méx." is not recognised.
- If Microsoft sends an event change in another time zone, the old time shows until the daily full re-sync (needs a
  Windows-to-IANA time-zone table).
- While a mailbox is in error its old Outlook events keep showing until it is fixed, switched off or disconnected.
- Administrators' Everyone view loads every overdue team task at once (fine now).
- An impossible date typed into the address bar (e.g. 31 Feb) is accepted, and empty calendar days cannot be reached
  with the keyboard — both as the prototype.
- Check the first live Outlook sync: compare times and all-day events with Outlook for a couple of users.
- Database tidy-up: the unused column `claude_monthly_cap_usd` can be dropped in a later migration.
