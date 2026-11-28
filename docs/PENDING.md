# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so. Items that were fixed are no longer listed (they are
in the git history).

## Where things stand (28 Nov 2026)

- **Live** at crm.daitpartners.com: release `edd28f9` (lead mail timeline, below) on top of web-mail release 3 `e83f6ea` (inline reply, full-page New message,
  drafts in Outlook, signature, Schedule send, Undo send, follow-up box after Send, task priority and note), live since
  28 Nov 2026. Your live check of the new Outlook actions is still pending (see "Live: web-mail release 3" below).
  Web-mail release 2's Outlook actions were checked on your own mailbox, all worked; release 1's backfill and clean-up
  have finished.
- **Live since 28 Nov 2026 as `edd28f9`:** lead mail timeline (one copy per email, every lead email on its lead's
  timeline by itself, the email Lead box shows the person in the email). One-time steps done on live: 225 duplicate
  copies removed (117 lead links carried), 175 past-mail timeline lines added on 117 leads, 116 leads moved to
  Contacted. Backup before it: `dait_crm-pre-lead-mail-timeline.dump`.
- **Ready, not yet live (branch `timeline-skip-auto`, owner OK 28 Nov):** bounces and automatic replies stay off the
  lead timelines (still in the Email screen, never change a stage; Log as activity can still log one by hand). On
  deploy, a one-time `timeline-automatic` clean-up removes the ones already there (about 15). Runbook:
  `docs/DEPLOYMENT.md`, "Timeline without bounces: deploy runbook".
- **Next (owner approved 28 Nov):** one lead per person — plan `docs/superpowers/plans/2026-11-28-lead-per-person.md`.
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
| Leads delete, import follow-ups | Delete leads with their company (Administrators), Download all leads, update rows through Import leads, Do not email list | `7d1d8c2` (live 26 Nov) |
| Web-mail release 1 | Lead mail only, 12-month backfill, team view (view only) for Administrators and Managers | `2f981c2` (live 27 Nov; clean-up done 27 Nov) |
| Web-mail release 2 | Microsoft 365-style Email screen; Delete, Archive, Move, Flag, Read change Outlook too; Reply all, Forward, attachments, lead panel | `70ec558` (live 27 Nov; backup `dait_crm-pre-web-mail-r2.dump`) |
| Web-mail release 3 | Inline reply, full-page New message, drafts in Outlook, signature, Schedule send, Undo send, follow-up box after Send | `e83f6ea` (live 28 Nov; owner's live check pending) |

## Live: web-mail release 3 (`e83f6ea`, since 28 Nov 2026)

Design: `docs/superpowers/specs/2026-11-26-web-mail-email-design.md` (mockup 2026-11-26-outlook-mail, states 2, 3
and 6). Live since 28 Nov 2026. Still open: your live check of the new Outlook actions (the list under "The deploy"
below).

**What changes for users:**
- **Reply, Reply all and Forward open inside the conversation** (no pop-up window): recipients with their lead tag,
  a formatting toolbar (font, size, bold, italic, underline, colour, highlight, lists, indent, link, picture, attach,
  Template, Signature), the original message folded underneath, Send ▾, Discard and "Draft saved". The pop-out button
  continues the same message on a full page.
- **New message is a full page** (`Email / New message`, with ← Back to Inbox): From, To, Cc, **Bcc**, Subject, Lead
  (with a search), Project when the client has projects, your templates, the toolbar, the message with your
  signature, attachments, and the chosen lead's summary on the right.
- **Everything you write is an Outlook draft.** It is saved by itself every few seconds into your Outlook Drafts, so
  you can carry on in the CRM or in Outlook. Drafts show in the CRM's Drafts folder; open one to carry on. A draft you
  open and leave without typing anything is removed again.
- **Formatting, pictures and attachments** in every message. Files go straight onto the Outlook draft; the CRM does not
  keep a copy.
- **Your email signature** (Settings → Email signature): formatted text and links, added by itself to new messages and
  replies when "Add automatically" is ticked (it is by default), or with the Signature button.
- **Schedule send:** Send ▾ → Later today 17:00 (before 17:00 only), Tomorrow morning 08:00, Monday morning 08:00, or
  a date and 24-hour time of your choice. When the lead's company is in another time zone, the box also shows the
  recipient's time. Waiting mail is in the **Scheduled** folder with **Edit**, **Send now** and **Cancel** (Cancel puts
  it back in Drafts).
- **Undo send:** after Send, a toast `Sent · follow-up added for …` (or `Sent`) with **Undo** for 10 seconds. Undo
  brings the message back into the editor; nothing has left.
- **"Set the next follow-up" after Send**, for mail to an open lead: Tomorrow 09:00, In 3 working days 09:00 (the
  default; working days skip Saturday and Sunday), In 1 week, In 2 weeks, or a date and time; the task title
  (`Follow up: <subject>`), who does it, Email / Call / Meeting, **Priority** (Normal / High), a **Note**, and "Also
  update the lead's next follow-up" (ticked). Or **Send without follow-up**. The task and the lead's date are added when
  the mail actually leaves (after the 10 seconds, or at the scheduled time).
- **Tasks:** a High task shows a **High** badge, and a task's note shows as a grey line under its title. Priority and
  Note can be set in the task dialog too.
- **The lead page's Email tab sends the same way** (an Outlook draft, the follow-up box, Schedule send, Undo); its own
  form layout stays. The old "follow-up in N days" choice there is gone (the follow-up box replaces it).

**Deliberate differences from the mockup (tell us if you want any changed):**
- **New message has no Client picker; it keeps a Project field.** The Lead picker replaces the Client picker (links
  from a company still narrow the leads offered), and the Project field keeps project tagging and the Projects list's
  Email button working.
- **Attachments from the CRM:** each file at most 2.5 MB, PDF, pictures or Office files only, at most 20 per message.
  Anything bigger or of another kind (zip, CSV …) is attached in Outlook; the message says so.
- **The signature has no pictures** (formatting and links only, at most 20 000 characters). A logo in the signature
  would need a later change.
- **One-to-one emails are not blocked for addresses on the Do not email list** (unchanged from before; the Mailer
  still skips them). Please decide whether a one-to-one email to such an address should be refused.

**Calls made for you (short; tell us if you want any changed):**
- Schedule send and Undo run on the CRM's own queue, not Outlook's delayed delivery, so the CRM can still edit, send
  now or cancel the mail. In Outlook a scheduled mail looks like an ordinary draft until it goes; if the CRM's
  background worker is down at that moment, the mail leaves when it is back (late, never lost, never sent twice).
- The follow-up box also opens for a scheduled send, and its choices count from the scheduled day. It opens only for
  an open lead you can see; closed leads get a plain send.
- An email follow-up task on the same day as the lead's next follow-up stands in for the lead's own follow-up task (no
  second task for the same follow-up).
- A send that fails (even hours later, for a scheduled one) stays in Drafts marked Failed, and you get a notification.
- Editing the same draft in Outlook and in the CRM at the same time: the last save wins.

**The deploy** (runbook: `docs/DEPLOYMENT.md`, "Web mail release 3: deploy runbook"): migration 28
(`20261214100000_web_mail_writing`, adds columns only), the usual worker restart, and a live check on Deepak's own
mailbox with Outlook on the web beside it: a new message saved into Outlook Drafts and discarded; reply / reply all /
forward drafts in the right Outlook conversation (a forward keeps its pictures); attachments and pictures; Send with
Undo (Undo once, then for real); Schedule send (it goes at its time; Cancel puts it back in Drafts; Send now); the
follow-up task in Tasks with its priority and note and the lead's next follow-up; the signature; the lead page send.
Any Outlook refusal, repeated "Outlook is busy", Failed send or server error means going back to release 2 (`70ec558`);
the new columns stay and release 2 runs on them. Before going back, mail still waiting to be sent (scheduled, or in
its 10 seconds) is taken out of the queue so release 2 does not send it the wrong way (it would leave without its
attachments, pictures or Bcc); it stays in the sender's Outlook Drafts, and those people are told to send it from
Outlook.

## Live: lead mail timeline (`edd28f9`, since 28 Nov 2026)

Design: `docs/superpowers/specs/2026-11-28-lead-mail-timeline-design.md`. Deployed 28 Nov 2026 on top of web-mail
release 3; both one-time steps done (dry runs shown to the owner first; re-runs show 0).

**What changes for users:**
- **One copy per email.** An email found by the 12-month search and again by the regular sync is stored once (today
  some lead emails show twice, for example Elaine Reyes's reply).
- **Every lead email is on the lead's timeline by itself**, sent or received, from any team mailbox:
  `Email sent · <subject>` by the team member who sent it, or `Email received · <subject>`, dated at the email. An email
  in two team mailboxes (sent by Carlos, Cc to Deepak) gives one line. A team member's email to someone outside the
  team moves a New or Not Contacted lead to Contacted, as a CRM send does; an email only between team members (for
  example a forward of the lead's inquiry to a colleague) gets its line but leaves the stage. A sales rep sees the
  subject of her own email even when the line was made from a colleague's copy. A quotation's sending email keeps its "Quotation sent" line only.
- **Past mail** gets its lines once, at the deploy.

**The deploy** (runbook: `docs/DEPLOYMENT.md`, "Lead mail timeline: deploy runbook"): no database change. After the
install, two one-time steps, each a dry run shown to you first, then the real run: `mail-dedupe` merges the duplicate
rows (225 on live), then `lead-mail-timeline` adds the missing timeline lines. Then a check that the KPMG lead
shows Carlos's "Email sent" line. Going back means switching to release 3 (`e83f6ea`); the merged rows and new lines
stay, and release 3 runs fine with them.

**Minor points left for later:**
- Two genuine copies of one email with the same id in two non-Sent folders of one mailbox (rare) are merged into one.
- `email_messages.message_id` has no index (the duplicate lookups are fine at today's size).
- The quotation check (audit lookup) is not indexed.
- Log as activity (`/log`) still picks its title by the inbound rule, not the team-sender rule.
- If the row a timeline line was made from is deleted in Outlook, a later copy of the same email may add a second line.

## Live: web-mail release 2 (`70ec558`, since 27 Nov 2026)

Design: `docs/superpowers/specs/2026-11-26-web-mail-email-design.md` (mockup 2026-11-26-outlook-mail). Live since
27 Nov 2026: Outlook mailboxes re-read for flags (no errors); the owner's live check of every Outlook action passed.
Still open: the read-only Graph flag due-date check (runbook step 2), to confirm flag days for users west of UTC.

**What changes for users:**
- **A new Email screen in the style of Microsoft 365 web mail:** a top bar with "Search lead mail" and a Filters panel
  (From, To, Subject, Lead, Owner, Date, Has attachments); a command bar (New mail ▾ with your templates, Delete,
  Archive, Move to ▾, Reply, Reply all, Forward, Flag ▾, Mark as read / unread, Follow-up ▾, Link to lead ▾, Log as
  activity) with a View tab (conversation view, Sort by, folder pane, lead panel); the folders (Inbox, Sent items,
  Drafts, Scheduled, Flagged, Archive, Deleted items) and the Leads views (Awaiting reply, Follow-up due today, My
  leads); a message list grouped by date with quick filters (All, Unread, Flagged, Attachments), tick boxes for several
  messages at once, hover actions and a right-click menu; the whole conversation in the reading pane, newest first; and
  a lead panel beside it (contact, owner, next follow-up, last activity, value, Recent on the lead, Open lead, Log as
  activity, Create task, Set follow-up, Add contact). Keyboard shortcuts work as in Outlook (Delete, E, R, Shift+R, F,
  N, Ctrl/⌘+U), never while typing in a box.
- **Delete, Archive, Move to, Flag and Mark as read / unread change Outlook too**, straight away, on your own mailbox.
  If Outlook refuses, the message goes back where it was and a message says why. Flags set in Outlook show in the CRM
  after the next sync (every 5 minutes). In someone else's mailbox (team view) everything stays view only.
- **Reply all and Forward**, besides Reply, all sent from your own mailbox and kept in the Outlook conversation.
- **Attachments:** each received file shows as a card with its size, **Download**, and **Preview** (opens in a new
  tab) for PDFs and pictures.
- **The Unlinked folder is gone.** Mail not yet linked to a lead stays in its folder (Inbox, Sent items …) without a
  badge; Link to lead ▾ links it to a lead or creates one from it ("Create lead from this email…").
- HTML emails now take their own height in the conversation (no scroll bar inside the email); links in them open in a
  new tab. Scripts in emails still never run.

**Calls made for you (tell us if you want any changed):**
- **"…" (more commands) has no Pin, Save as .eml or Email settings,** and there is **no React (smile) button**: Pin is
  not in the design, .eml and settings are not in the specification, and Microsoft Graph has no reactions call.
- **Delete inside Deleted items deletes permanently**, from Outlook too, after a confirmation.
- **In conversation view an action applies to the whole conversation** in the folder you are looking at (as Outlook):
  archiving a conversation archives all its messages there.
- **The lead panel's Value is the total of the lead's last sent quotation** (leads have no value field), written as
  the CRM writes amounts elsewhere (`USD 48,000.00`, not the mockup's `US$ 48,000`); "—" when nothing was sent.
- **A "This week" group** sits between Yesterday and Last week in the message list.
- **Preview covers PDFs and pictures only**; every other file is a download.
- **Scheduled lists the CRM's outbox** (mail waiting to be sent) until release 3.
- **The Filters panel's Owner is the lead's owner.** **Sort by Size is approximate** (Outlook's sync does not give a
  message's size, so the CRM estimates it from the body; mail stored before release 2 keeps its stored attachment
  names).
- **The View tab holds the view switches** (conversation view, sorting, the two panes).
- **Link to lead is disabled in someone else's mailbox** (team view stays view only, as the specification says).
- **A follow-up set from an email** puts the date on the lead and the time on the assignee's task.
- **The "Show mail for" row and the folder-pane template list leave the screen:** links from Companies, Leads and
  Projects still open the Email screen filtered (one removable chip), and templates are under New mail ▾.
- **The thread history in the old side panel is replaced** by the conversation in the reading pane and "Recent on the
  lead" in the lead panel.
- **Forwarding a message sent from the CRM** (not yet synced back from Outlook) carries the original text but not its
  attachments. Reply all on a message with nobody else on it replies to the sender only (as Outlook).
- **The email frame on the Email screen is same-origin and allows pop-ups** (so links in emails open, and the CRM can
  size the frame to the email): `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, still with
  no scripts, forms or top navigation, and the frame refuses scripts in its own security policy
  (`default-src 'none'; script-src 'none'`). The Mailer and lead page frames are unchanged.

**The deploy** (runbook: `docs/DEPLOYMENT.md`, "Web mail release 2: deploy runbook"): migration 27
(`20261213100000_web_mail_screen`, two flag columns and a size column on stored mail, with a back-fill) plus **one
one-time step: after the release 1 backfill has finished, clear the stored sync links** so each mailbox is read once
more and flags already set in Outlook reach the CRM (that re-read takes a while; nothing is lost). Then one read-only
check on live of how Outlook writes a flag's due date (it decides whether users west of UTC see the right day).

## Live: web-mail release 1 (`2f981c2`, since 27 Nov 2026)

**Status on live:** migration 26 applied. The backfill has finished: 561 searches done, 220 emails stored, no
failures. **Clean-up done 27 Nov 2026** (owner OK): checked 916 stored messages, kept 557, removed 359 non-lead
messages (they stay in Outlook); a second run removes 0. Copy of the mail table taken just before:
`/home/daitcrm/backups/dait_crm-pre-mail-cleanup.dump` (restore rows by id from it if any were removed wrongly).

Design: `docs/superpowers/specs/2026-11-26-web-mail-email-design.md`.

**What changes:**
- **The CRM stores lead mail only.** Mail sync keeps a message only when it is with a lead or contact address (or that
  address's company domain, never free mail such as Gmail), or belongs to a conversation that already has lead mail.
  **Other mail (personal, colleagues, suppliers, newsletters) leaves the CRM and stays in Outlook only**: it is
  no longer copied in, and the clean-up below removes what was copied before. Nothing is deleted from Outlook.
- The first sync of a mailbox reads the last **12 months** (was 90 days) and now includes Deleted Items.
- **Backfill:** after the deploy the CRM searches each connected mailbox for 12 months of mail with every existing
  lead and contact address, a little at a time over several hours. New leads and contacts get the same search within a
  minute of being added.
- **Administrators and Managers read every user's lead mail, view only:** a "Mail of" picker on the Email screen, a
  "View only — Carlos's mailbox" banner, no reply, send, delete or mark-read on someone else's mail; each opening is
  recorded in the audit log (without the content). The lead page's Emails tab and timeline show the whole team's mail
  with that lead to them. Sales representatives and Data research users still see only their own mail. The Outlook
  calendar stays private to its owner, administrators included.
- A rep's own mail with a lead owned by someone else shows a plain "LD-xxxx · another owner's lead" chip with the
  company name only.
- Mail is linked to the open lead first, then the most recently active one, whoever owns it.

**The deploy's two one-time steps** (runbook: `docs/DEPLOYMENT.md`, "Web mail release 1: deploy runbook"; step 2 is
done, step 1's real run waits for your OK):
1. **Clean-up:** a dry run first; you see the counts per user (how many messages kept and removed, no subjects or
   addresses) and say OK; then a fresh copy of the mail table is taken and the real run follows. If it finds leads
   deleted before this release whose addresses cannot be found, it stops and we ask you before going ahead.
2. **Watching the backfill** until it has finished (several hours), plus two one-off checks on live (long searches go
   past 250 results; the 12-month start date is read as UTC). A mailbox connected later (Sebastian has none yet) or
   reconnected later gets its 12-month search with one command run after it connects; tell us when that happens.

**Calls made for you (tell us if you want any changed):**
- **Drafts are left out of the team view:** Administrators and Managers do not see another user's drafts.
- **The clean-up keeps project-tagged mail** (and mail linked to a lead, contact or company, queued or sending mail,
  Mailer and quotation mail, mail in a lead conversation, and mail of deleted leads), even when it is not with a lead
  address.
- **Unlinked and My leads stay as they are until release 2** (the full Microsoft 365-style Email screen).
- **Mail linked to a company only is readable by Administrators and Managers too.** The clean-up keeps mail the CRM
  had already linked to a company (any company in the CRM, even one with no lead); in the team view, Administrators
  and Managers can read it like lead mail, so some mail with prospect companies becomes visible to them.
- **Emptying Deleted Items in Outlook removes the CRM copy**, lead-linked mail included. Moving a message to Deleted
  Items keeps it in the CRM (shown as deleted); only emptying the folder, or deleting it permanently, removes it.

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
- **Import leads (release 5, after it is deployed):** Claude Code must be switched on with a monthly run cap (see the
  Claude Code item above) for Import leads to read PDF / Word / text files with Claude and to research rows with web
  search; with Claude off only the deterministic reader and the free website reader run. Optionally add a catch-all
  English allocation rule in Settings (see "Import leads" below, Q4).
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
- Lead mail belongs to the mailbox owner. Administrators and Managers can read every user's lead mail (view only, each opening audited); Sales representatives and Data research users see only their own. Personal and other mail is not stored. The Outlook calendar stays private to its owner, administrators included. Calendar **Mine / Everyone** is
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
  from blocking the CRM). Every body is parsed in a worker thread with a 3-second limit; one that takes longer (only a
  deliberately malformed email does) is kept as plain text with no formatting. When the limit was hit because the server
  was busy (a time-out or a crashed parsing thread, not an email too deep to read), it is tried once more on the next
  sync or open before staying plain text; each such case is logged with the message id and the reason only. The pause on asking Microsoft for older
  bodies (after a refusal or three failures) is kept per process: fine with today's single API process (see
  `docs/DEPLOYMENT.md`). The HTML body sits in a sandboxed
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
- Web mail release 3 (final review, 28 Nov 2026):
  - Undo clicked after leaving the screen that sent (another conversation, or off the lead page) puts the mail safely
    back in Drafts, but nothing on screen says so; open it from Drafts.
  - If a sync reads Sent Items in the few milliseconds between Outlook taking a mail and the CRM marking it sent, the
    copy is stored as a second row: two rows in Sent items for one mail (the same window existed for release 2 sends).
  - The message written to Outlook can reach about 400,000 characters: up to 200,000 of the user's own text plus up to
    200,000 of the quoted message (both sanitised; well under Microsoft's 4 MB limit).
- To tell you at hand-over (web mail release 3, no change planned): the follow-up box's date field follows the
  browser's language settings (an English (US) browser shows 12/02/2026); New message shows about 30 px of extra space
  before the signature.

## Formatted email templates (branch `template-html`, not yet released)

- **Re-upload your .oft templates** (Settings → Email templates → Upload .oft template) to get their formatting: templates
  uploaded before this change were saved as text only and keep working as plain text. A formatted template shows a
  "Formatted" badge.
- **Pictures and attachments inside an .oft (branch `template-attachments`, not yet released):** the logos and other
  inline pictures (cid: images) and the attached files (PDF, Word, Excel, PowerPoint, pictures) are now kept with the
  template, shown in the message and sent with it (lead Email tab, Compose, Mailer). At most 2.5 MB of files per
  template; a file over the limit or of another type is left out with a notice.
- **Re-upload your existing .oft templates once more after that release** (e.g. "DAIT-Holiday-2026-Email_2"): templates
  uploaded before it have no pictures or attachments stored, so they send without the logos and the PDF. Delete the
  old copy after re-uploading.
- A merge field Outlook split with formatting in the middle (e.g. `{first_<b>name</b>}`) is not filled; type merge fields
  in one go in Outlook.

## Import leads (release 5, branch `import-leads`, not yet released)

**Decided: controller rulings of 24 Nov 2026 (you may overturn any of them).** Q1 and Q3 differ from the written spec;
both are recorded in the spec's "Deviations from the spec" section
(`docs/superpowers/specs/2026-11-24-import-leads-design.md`).
- **Q1, Ready rule (deviation):** a row is "Ready" when it has a company, a country and an **email** (as the approved
  mockup). A row with only a phone or only a website is "Missing details" and goes to research. Research values never
  change a row's status.
- **Q2, unticked "Accept research values ≥ 80%":** research values stay suggestions. Rows that rely on them for their
  only email or phone are listed under "Rows that still need you" (Import them / Leave them out, nothing pre-chosen);
  rows whose country exists only from research are listed there too and in the rows-to-fix download.
- **Q3, daily research limit (deviation):** imports are exempt from the daily research limit. Rows read only by the free
  website reader count toward nothing; every Claude call an import makes (reading a document or researching a row)
  counts toward the monthly Claude run cap only, reserved before the call. Company research (release 4) keeps the daily
  limit as today.
- **Q4, allocation:** unchanged. Rows that no allocation rule matches import **unassigned** (as today); step 4 says so.
  If you want every English import assigned, add a catch-all English rule in Settings.
- **Q5, who can import:** the right `import_leads` is given to Administrators and Managers; Undo (`undo_imports`) to
  Administrators only. A Sales Representative does not see the Import leads button and is refused the page.

**Notes for the release:**
- `STORAGE_DIR` (uploads, `shared/storage/imports`) is set for the API and the worker in `deploy/ecosystem.config.cjs`
  (live and any future test copy); see `docs/ENVIRONMENT.md` and `docs/DEPLOYMENT.md`. Migrations 20 and 21
  (`docs/MIGRATIONS.md`).
- Original files are deleted 90 days after upload (the batch, its rows and its leads stay; the Data manager then shows
  "Deleted after 90 days").
- The old one-step CSV endpoints `/api/imports/leads/preview` and `/api/imports/leads` are no longer used by the
  screens and now need `import_leads` (Administrators and Managers); remove them in the release after this one.
- **One worker lane for imports and file reads:** reading uploads and importing batches share the worker's `import`
  lane. A 5,000-row import takes about 100 s (more on live, with allocation), and other people's uploads wait at
  "Reading" until it finishes.
- **Rollback after the migrations:** the `company_name_normalise` migration (20 on this branch, 21 once
  `email-reader-html` is merged first) rewrites `companies.name_normalised`. If a deploy is rolled back, the previous
  release runs against the rewritten keys, so duplicate matching by name is weaker until the next deploy (nothing is
  lost; the keys are derived).
- **Release checks:** the server build (`npm ci`) must reach `cdn.sheetjs.com` (the `xlsx` package is a tarball from
  there); after the deploy, upload one 20 MB file through OpenLiteSpeed on live to confirm the proxy allows the body
  size.
- Claude counting: one monthly cap covers company research runs, import row research and import document calls; the
  step-3 tile shows this month's total against the cap.

**Known minors left as they are (from the task reviews):**
- Row errors from field validation are stored as English text ("path: message"); store a code + field name so the Data
  manager can translate them.
- "M." is in the honorific list (French "Monsieur"), so an Indian initial style such as "M. Karthik" is read as
  "Karthik" when matching and splitting names; and a row whose contact name matches an existing contact reuses that
  contact even when its email differs.
- The heading-word list can still drop a real company named only with heading words when the block has no contact
  value and no matching website (e.g. "Exhibitor Services").
- A one-line record without separators ("Contact Mr.Smith at Acme Ltd v1.2.3 info@acme.com") gives the whole line as
  the company.
- A document read with Claude is staged once, at the end of the file (rows appear only when the whole file is read; a
  long file can take up to about 12 minutes). Kept so a file over 5,000 rows is refused as a whole.
- Claude calls on a file are counted in the month of the file's last `readAt`: a read that spans midnight on the 1st,
  or a file read again in a new month, counts its earlier calls in the newer month (over-count of the current month).
- The public suffix list used to check found websites ages with the pinned `tldts` version; bump it now and then.
- Real 12,000-character chunk timing: measure Claude's time per chunk on a real, dense exhibitor list after the release
  (dense chunks may come close to the call timeout).
- The Data manager's Errors tab shows each row's staged (step-2) status badge, so a row that failed at import usually
  reads "Ready" next to "Why it was not imported". The Status column could be hidden on that tab if it confuses.
