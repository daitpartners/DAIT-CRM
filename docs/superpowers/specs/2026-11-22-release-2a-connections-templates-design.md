# Release 2A — personal mailbox connections and email templates (short design)

Owner, 22 Nov 2026: "let's work on release 2"; Microsoft 365 app registration done and verified the same day (Deepak
signed in with Microsoft, system mailbox connected, test email sent). Standing rule: build what the final design
(`prototype/index.html`) shows. For 2A the owner chose **Microsoft 365 only** ("go with your recommendation").

Release 2 is built in parts, each deployed on its own: **2A** connections + templates (this), **2B** Email screen,
mail sync and real sending from the lead page, **2C** Mailer.

## Intent

Every salesperson connects their own Microsoft 365 mailbox, and the team keeps a shared library of email templates
(written in the CRM or uploaded as Outlook `.oft` files) that every compose box offers. 2B and 2C send and read mail
through these mailboxes and use these templates.

## Goals / non-goals / anti-goals

- Goals: prototype `V.connectionsCard` and `V.templatesCard` (views-settings.js) in Settings; the lead page's Email tab
  Template list filled from the library with merge fields applied.
- Non-goals: mail sync, the Email screen and real sending (2B); calendar sync (release 3); Google Workspace and
  IMAP/SMTP (later, owner's choice).
- Anti-goals: storing or logging tokens in clear (they stay encrypted, as for the system mailbox); a control that
  pretends to work (Sync now and Other provider say which part brings them).

## Approaches

1. **Chosen:** extend `email_accounts` with personal rows (`kind = 'personal'`, one per user) and reuse the existing
   Microsoft connect flow (`/auth/microsoft/connect`, PKCE state cookie, encrypted refresh token) with a `personal` mode.
2. A separate table for personal mailboxes — rejected: duplicates the token handling 1A already tested.
3. All three providers now — rejected by the owner (Microsoft 365 only for now).

## Decided

**Data (one migration):**
- `email_accounts`: unique key becomes `(address, kind)` (Deepak's personal mailbox is the system mailbox's address);
  add `sync_mail boolean default true`, `sync_calendar boolean default false`, `shared_mailboxes text[] default '{}'`,
  `last_sync_at timestamptz null`, `message_count int default 0`. At most one `personal` row per user (reconnect
  replaces it).
- `email_templates` (data-model.md): `id, name varchar(150), language char(2), subject varchar(500), body text,
  source_type ('manual' | 'oft'), file_name, file_size, created_by → users, created_at, updated_at`. The uploaded file
  itself is not kept (the prototype keeps name and size only); merge fields are read from the text when used.

**API:**
- `GET /mailboxes` → `{ mine, all }` (`all` only for `view_admin_settings`; personal rows, newest first).
- `GET /auth/microsoft/connect?mode=personal` → Microsoft consent → callback stores the signed-in user's mailbox
  (address from Graph `/me`) as their personal row; back to `/settings/connections?connected=1`.
- `PATCH /mailboxes/:id` (owner or admin): `syncMail, syncCalendar, sharedMailboxes` (valid addresses, max 10).
- `POST /mailboxes/:id/disconnect` (owner or admin): deletes the stored token, status `disconnected`.
- `GET /email-templates` (any signed-in user; the user's language first, then by name), `POST`, `PATCH /:id`,
  `DELETE /:id` (any user with `manage_leads`, as the prototype lets every user maintain the library; `updatedAt`
  concurrency like other records; audit on create/update/delete).

**Settings → Email & calendar connections** (prototype card, top to bottom): heading + "Each user connects their own
mailbox. Sending, receiving and calendar sync run through it."; **Connect Microsoft 365** (only while you have no
mailbox) and **Other provider** (opens the prototype's provider list; Google Workspace and IMAP show "Coming later");
the warning note while not connected; one row per mailbox (Microsoft logo, address · owner, "Microsoft 365 ·
Connected · synced {when|never} · n messages", **Sync now**, **Options**, **Disconnect** with confirm); administrators
also see everyone's rows, the System mailbox card (from 1A) and the collapsed app-registration note. **Sync now**
answers "Mail sync arrives with the Email screen (part 2B)" until 2B. **Options** = the prototype dialog (Sync mail,
Sync calendar, Shared mailboxes to include, the note about automatic linking).

**Settings → Email templates** (prototype card): heading + merge-field line; **Write a template**, **Upload .oft
template** (`.oft`/`.msg`, parsed in the browser by a port of `prototype/js/oft.js`; on a parse failure the editor
opens empty with the prototype's warning); table Template (name, file name · size for .oft), Source badge, Language,
Subject, Added (who · date), **Edit** / **Delete** (confirm); the prototype's footer help text. Editor dialog: Name,
Language (English / Español / Français), Subject, Body, merge-field help.

**Lead page Email tab:** the Template select lists the library (the user's language first; other languages marked
"(ES)" / "(FR)", `.oft` ones marked "· .oft"); choosing one fills Subject and Message with `{first_name}` (contact
first name, else company), `{company}`, `{me}`, `{lead_id}` (lead number) replaced; `{quote_no}` is left empty until
quotations exist.

## Left to the builder

Component split, the `.oft` port's tests (a real sample `.oft` is in `docs/sample-template.oft`), migration naming.
