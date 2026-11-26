# Email screen like Microsoft 365 web mail, lead mail only (design)

Owner (Deepak), 26 Nov 2026. Approved mockup:
`docs/superpowers/mockups/2026-11-26-outlook-mail.html` (artifact https://claude.ai/artifact/FgJ5r4rxtaAhALGzJJpi8M,
version 3). Screenshots of every state: `~/Documents/DAIT-CRM/mockup-screens-outlook-mail/`. **The mockup is the
spec for the screen; build what it shows.**

## Intent and the why
- Owner: "check Microsoft web version and replicate same for mail in CRM as there a very good engaging option, the one
  we have is not covering all the options." The owner means Microsoft 365 web mail in the browser
  (outlook.office.com), not the desktop app.
- Purpose: "mostly use CRM for leads and followup as this will give admin visibility of leads and day day task."
  The team keeps Outlook for everything else.
- "should not want to sync all emails with CRM only leads email id's will be link with crm."
- HTML emails must look identical to web mail ("look and feel suppose to identical with outlook").
- Owner additions after the first mockup: New message opens as a full page, not a pop-up; pressing Send (new message
  **and** reply) opens a follow-up box, default **3 working days**, which adds a task. Conversation **newest on top**.
  **Managers see the whole team's lead mail**, like Administrators.

## Goals
1. Only lead mail in the CRM (rules below); personal and other mail never stored, and what is stored today but isn't
   lead mail is removed.
2. Administrators and Managers can read every user's lead mail, view only. Sales reps and Data research users see
   only their own (unchanged).
3. Email screen laid out and behaving like web mail (mockup states 1–6), in the live CRM theme.
4. Mail actions that work in Outlook too (two-way): Reply, Reply all, Forward, Delete, Archive, Move to, Flag, Mark
   read/unread, received attachments (preview/download), Bcc, formatting, signature, Schedule send, Undo send.
5. CRM actions in the same places: Follow-up (lead next follow-up), Link to lead, Log as activity, Create task,
   Schedule meeting, Open lead.
6. Send → "Set the next follow-up" box → task in Tasks (+ lead next follow-up).

## Non-goals / anti-goals
- Not a full Outlook replacement: no Junk, rules, the user's own Outlook folders, Focused/Other, categories, Pin,
  Outlook Snooze (CRM Follow-up replaces it), calendar inside mail, shared mailboxes.
- No Unlinked folder; no "create a lead from an unknown sender" flow from incoming mail (Link to lead menu keeps
  "Create lead from this email…" for mail already in the CRM).
- **Failure even if it works:** any non-lead mail stored or shown; a Sales rep seeing another user's mail; an admin
  or manager able to send, delete, move or flag mail in someone else's mailbox; an HTML email that looks different
  from web mail or that can run script / load trackers without the existing protections; Outlook and CRM disagreeing
  about where a message is.
- Not a phone app: phone width only must not break.

## Constraints (standing rules)
- Live CRM theme only (colours, Montserrat, components). Layout follows web mail, skin follows the CRM.
- en/es/fr for all UI text. Dates/times 24-hour in the viewer's timezone.
- Tokens and secrets stay on the server. Pin any new npm dependency to a version ≥ 2 weeks old.
- Existing HTML safety stays: sanitiser in the worker thread with caps; sandboxed iframe reader; image/tracker rules.
- Existing Microsoft permission already includes Mail.ReadWrite and Mail.Send: no reconnect needed. If a feature
  would need a new permission, leave it out and say so.
- Deploy only on the owner's "deploy"; database backup first.

## Approaches considered (my call; the owner handed over the how)
1. **Filter at sync (chosen).** Keep the existing per-folder Graph delta sync, but store a message only if a
   participant matches a lead/contact address or a lead company's own domain; backfill per address when a lead or
   contact is added or its email changes. Cheap, reuses today's sync, and nothing personal is ever written.
2. Search per lead address with Graph `$search`/`$filter` on a schedule. Precise, but many calls per user per run
   (hundreds of leads), throttling risk, and replies from colleagues at the same company are missed.
3. Sync everything, hide non-lead mail. Simplest, but stores personal mail, which the owner explicitly doesn't want.

## Decided
### What counts as lead mail
- A message is kept if any of From, To, Cc (and Bcc on sent mail) is:
  - an email address on a lead or a contact in the CRM (case-insensitive, trimmed), or
  - an address at the **own domain of a lead's company**: the company's website domain (or the domain of its lead/
    contact addresses) when that domain is **not** a free/public mail domain (gmail.com, googlemail.com, outlook.com,
    hotmail.*, live.*, msn.com, yahoo.*, icloud.com, me.com, aol.com, proton.me, protonmail.com, gmx.*, zoho.com,
    yandex.*, mail.com, qq.com, 163.com and similar; keep the list in one shared place).
  - Our own domain (daitpartners.com) never counts as a lead domain.
- Kept mail is linked to its lead as today (match.ts); when several leads match, today's matching rules decide.
- **Archived/closed leads still count** (history stays). Deleted leads (lead delete feature) stop counting; mail
  already stored for them follows the lead-delete rules already live.
- **Backfill:** when a lead or contact is created, or its email changes, fetch that address's mail from the last
  **12 months** from the user's mailbox folders that the CRM syncs (Inbox, Sent, Drafts, Archive, Deleted items),
  for **every connected user** (the lead may have written to anyone on the team). Run as background jobs, rate
  limited; the lead page shows mail as it arrives.
- **Clean-up on release:** remove stored messages (and their bodies/files) that are not lead mail under these rules.
  It stays in Outlook untouched. Record counts per user in the log; no message content in logs.
- The folder pane footer note and its "Why?" popover (mockup) explain the rule in plain words.

### Who sees what
- Owner of the mailbox: full access to their lead mail, all actions.
- **Administrator and Manager:** "Mail of:" picker (Me default / Everyone / each user). In team view they can read
  every message, open attachments, Log as activity, Create task, Set follow-up, Open lead. They **cannot** Reply,
  Reply all, Forward, Delete, Archive, Move, Flag, mark read/unread or link/unlink in another user's mailbox; those
  controls are disabled with "View only — <Name>'s mailbox". Reading someone else's mail must not mark it read.
- Sales representative and Data research user: own mail only (as today). Server-side enforcement on every mail route,
  not just hidden buttons.
- The lead page Emails tab and timeline email lines follow the same rule (Admin/Manager see all lead mail on the
  lead; others their own). Update the privacy wording in docs (the old rule "mail private to its owner,
  administrators included" is replaced for lead mail by this rule).
- Audit when an Administrator/Manager opens another user's message (who, which message id, when) — no content.

### Screen (see mockup)
- Top bar: title, connected mailbox line, **Search lead mail** with Filters panel (From, To, Subject, Lead, Owner,
  Date, Has attachments), Sync now.
- Command bar (Home): New mail ▾ (New mail / New from template — real templates from the Mailer/templates list /
  Manage templates…), Delete, Archive, Move to ▾ (Inbox, Archive, Deleted items), Reply, Reply all, Forward, Flag ▾
  (Today, Tomorrow, This week, Next week, No date, Mark complete, Clear flag), Mark as unread, then the CRM commands
  in orange: Follow-up ▾, Link to lead ▾, Log as activity, Create task, Schedule meeting; "…" overflow takes what
  doesn't fit, icon-only labels with tooltips when narrow (as the mockup). Hidden on the New message page.
- Folder pane (collapsible, remembered as today): Mail of picker (Admin/Manager only), Inbox (unread), Sent items,
  Drafts, Scheduled, Flagged, Archive, Deleted items; "Leads" group: Awaiting reply, Follow-up due today, My leads
  (Team leads in team view). Footer note "Only mail with your leads and contacts is shown here · Why?".
- Message list: chips All / Unread / Flagged / Attachments; Conversation view toggle (on by default); sort ▾ (Date,
  From, Lead, Lead stage, Size; newest/oldest on top); groups Today / Yesterday / Last week / older; row = avatar,
  sender (bold unread), subject, conversation count, time, preview, icons (replied, attachment, flag), lead chip
  "LD-xxxx · Stage", mailbox owner in team view; hover actions Delete / Archive / Flag / Mark unread; checkbox on
  avatar hover for multi-select (bulk Delete/Archive/Move/Flag/Mark read); right-click menu (mockup state 4).
  Infinite scroll as today, no page numbers.
- Reading pane: subject, lead chip, company, message count; conversation **newest on top**, newest expanded, older
  collapsed rows (click to expand); per-message Reply / Reply all / Forward / More; attachment cards above the body
  with Preview and Download; HTML in the existing sandboxed frame, auto-height.
- Lead panel (collapsible; starts folded below 1400 px): company, stage, contact, email, phone, owner, next
  follow-up (red when due), last activity, value; Open lead, Log as activity, Create task, Set follow-up; Recent on
  the lead.
- Keyboard: Delete, E (archive), Ctrl+U (unread), R (reply), Shift+R (reply all), F (forward), N (new), Esc.

### Writing
- **Reply / Reply all / Forward**: inline editor at the top of the conversation (state 2): To/Cc/Bcc chips with lead
  tag, formatting toolbar (font, size, B I U, colour, highlight, bullets, numbering, indent, link, picture, attach,
  Template, Signature), quoted text folded "…", Send ▾ (Send / Schedule send), Discard, "Draft saved hh:mm", pop-out
  to the full page. Sent through Graph from the user's own mailbox so it threads in Outlook.
- **New message**: full page inside the Email screen (state 3), route of its own so the browser Back works; From (own
  mailbox), To, Cc, Bcc, Subject, Lead picker ("Filed on the lead's timeline when sent"), template bar, toolbar,
  body, signature, attachments; lead summary on the right.
- **Drafts** auto-save to the user's Outlook Drafts and show in Drafts.
- **Signature**: one per user, edited in Settings (rich text), inserted on new/reply when the user ticks
  "Add automatically" (default on).
- **Schedule send**: Later today 17:00 / Tomorrow 08:00 / Monday 08:00 / custom date-time; Scheduled folder lists
  them with Edit / Send now / Cancel. Use Graph deferred send if available with current permissions; otherwise the
  CRM's job queue sends at the time. Builder decides, must survive restarts.
- **Undo send**: 10 seconds before the mail actually leaves; toast "Sent · follow-up added for <date> · Undo" /
  "Sent · Undo".

### Follow-up after Send (state 6)
- Opens on Send for new messages and replies, when the mail is linked to a lead (no lead → no box, plain send).
- Choices: Tomorrow 09:00, **In 3 working days 09:00 (default)**, In 1 week, In 2 weeks, Choose date and time.
  Working days skip Saturday and Sunday only (no holiday calendar). Times in the user's timezone, 24-hour.
- Fields: task title "Follow up: <subject>" (editable), Assigned to (default me; active users), Type (Email / Call /
  Meeting), Priority (Normal / High), Note (optional), "Also update the lead's next follow-up" (ticked).
- Buttons: **Send and add follow-up** (primary) → sends and creates the task (Tasks, origin "email follow-up") and,
  if ticked, sets the lead's next follow-up; **Send without follow-up**; Cancel (back to editing).
- Undo within the 10 seconds also removes the task and restores the lead's previous next follow-up.
- Who may assign to others follows today's task-assignment rights.

### Two-way with Outlook
- Delete → Outlook Deleted Items; Archive → Archive; Move → chosen folder; Flag/unflag with due date; read/unread;
  all via Graph on the owner's mailbox, reflected in the CRM immediately and corrected by the next sync if Graph
  refuses (show a toast).
- Changes made in Outlook show up in the CRM on the next sync (delta).
- Received attachments are fetched from Graph on demand (Preview / Download) through the server; nothing new is
  stored unless needed for preview caching (builder's call, with the existing size caps).

## Settled after the builder check (my calls, flagged to the owner)
1. **Linking ignores who can see the lead.** Kept mail links to its lead even when the lead is closed, archived or
   owned by someone else (prefer an open lead, then the most recently active one). This is what gives Admins and
   Managers the full picture on the lead. A Sales rep whose own mail is linked to a lead they can't open sees a
   plain chip "LD-xxxx · another owner's lead" and a lead panel with company name only (no details, no Open lead);
   no lead data beyond what the email already shows leaks to them.
2. **Checked when stored, plus a one-off clean-up.** No ongoing re-check: once kept, a message stays (Delete removes
   it). Changing or removing a contact's email or a company domain doesn't delete stored mail. Mail already kept
   for deleted leads follows the live lead-delete rule (kept, unlinked) and is **exempt** from the release clean-up.
3. **A conversation counts.** A message whose conversation already has a kept, lead-linked message is kept too
   (internal forward, lead dropped from Cc), so conversation view has no gaps. Clean-up applies the same rule.
4. **Release backfill.** At release, a background backfill fetches the last 12 months for every existing lead and
   contact address, for every connected user, rate limited, spread over hours, resumable; a deploy-runbook step
   says how to watch it. Backfill uses exact addresses; colleagues at the same company domain are picked up by the
   normal sync (whose initial window becomes 12 months for new mailboxes) and by conversation (3).
5. **Lead next follow-up stays a date.** The time lives on the task (`dueTime`). The lead panel shows the open
   follow-up task's date and time when there is one, else the lead's date.
6. **Task fields.** Type maps to the existing kinds (Email → followup, Call → call, Meeting → meeting). Add
   `priority` (normal/high) and `note` to tasks; the Tasks screen shows a small "High" badge and the note as a
   second muted line (owner-approved box implies them; flag in the hand-over).
7. **Lead page sends the same way.** The lead page's Email tab uses the same send path: follow-up box (replaces
   today's follow-up-days choice), Undo send and Schedule send. One implementation for both screens.
8. Deleted Items joins the synced folders; team view shows one row per mailbox for the same message.

## Left to the builder
Exact components, file structure, job design for backfill/clean-up, how to store flags/conversation grouping,
search implementation, the Scheduled-send mechanism, preview of PDF/XLSX, test approach. Split into releases if
sensible (suggested order: sync scope + clean-up + visibility; screen + actions; writing + follow-up), each passing
review and the full suite, deployed only on "deploy". Before "done": side-by-side screenshots of every mockup state
against the built screen (1440 and 1280, en/es/fr) into `~/Documents/DAIT-CRM/parity-screenshots-web-mail/`.
