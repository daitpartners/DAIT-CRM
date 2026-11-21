# Release 2B-2 — mail sync and the Email screen (design)

Owner, 22 Nov 2026: approved the 2B-2 outline ("yes, goahead for next") after 2B-1 went live (ccfb2b4). Standing rule:
build what the final design (`prototype/index.html`, `V.email` in `views-work.js`, `V.compose` in `views-projects.js`)
shows. Privacy rule (owner, verbatim): "others email will not be seen to anyone ie., admin as well. Seba will be seeing
his own mail while client is reply."

## Intent

Each salesperson works their own Microsoft 365 mail inside the CRM: replies from prospects arrive on their own, are
linked to the right lead, contact and company, and can be answered, logged on the lead, turned into a task or into a new
lead without leaving the CRM. Nobody else, administrators included, ever sees another person's mail.

## Goals / non-goals / anti-goals

- Goals: mail sync (inbox, sent items, drafts, archive; last 90 days, then every 5 minutes); automatic linking; the
  Email screen as in the prototype; sidebar Email entry with the unread count; the lead's Emails tab shows replies too;
  Sync now on Settings → Connections.
- Non-goals: editing drafts (view only; edited in Outlook); downloading attachments (names only); shared mailboxes
  (personal mailbox only; the Options dialog's list is kept for later); projects and meetings (release 3: the Project
  filter, the Compose Project field and "Create meeting" are shown greyed); calendar sync; Mailer (2C).
- Anti-goals: any route by which one user reaches another user's message; tokens in clear or in logs; a sync that loses
  links the user made by hand.

## Approaches

1. **Chosen:** poll Graph per folder with delta queries from the worker (delta link stored per folder), messages in the
   existing `email_messages` table, Graph writes (mark read, archive, reply) as jobs.
2. Graph change notifications — rejected (public webhook endpoint, subscription renewal; not worth it for four mailboxes).
3. Reading mail live from Graph on each screen load (no local copy) — rejected: no search or linking across mail, slow,
   and the lead's Emails tab would need Graph on every lead page.

## Decided

**Data (one migration).**
- `email_messages`: add `graph_id varchar(255) null` (Graph immutable id; unique with `user_id`), `source`
  (`'crm'` written in the CRM | `'sync'` read from the mailbox, default `'crm'`), `from_name varchar(255) null`,
  `attachment_names jsonb default '[]'`, `reply_to_id → email_messages (set null)`, `logged_at timestamptz null`.
  Statuses gain `'received'` (inbound) and `'draft'`. Index `(user_id, thread_id)`.
- `email_accounts`: add `sync_state jsonb default '{}'` (per folder: the next or delta link).
- Reconnecting a mailbox under a different user or address clears `sync_state`; messages always stay with the user
  they were synced for (unique key `(user_id, graph_id)`), so a taken-over mailbox never shows the old owner's mail.

**Sync (worker job `sync_mailbox {accountId}`).**
- The worker schedules one per connected personal mailbox with Sync mail on, 5 minutes after its last sync (checked
  every minute; never two queued for one mailbox). **Sync now** (owner of the mailbox only) runs it at once.
- Folders `inbox`, `sentitems`, `drafts`, `archive`, each from its stored link, else a delta query from 90 days ago
  (`receivedDateTime ge`), 50 per page, body as text (kept to 50,000 characters), immutable ids. At most 20 pages per
  folder per run; more → the next run in 1 minute. An expired delta link (HTTP 410) restarts that folder.
- New message: a message the CRM sent (same user, `source crm`, no Graph id, same recipient, subject equal ignoring
  "Re:/RE:/Fw:", within 15 minutes) takes the Graph id instead of a second row. Otherwise a row with the folder,
  `received` (from someone else) / `sent` / `draft`, read flag, attachment names (one Graph call when it has any), and
  links from matching. Existing message: read flag and folder updated; links never overwritten.
- Removed messages are applied at the end of a run, and only when the row is still in the folder that removed it (a
  move between synced folders keeps the row). A removed synced message is deleted; a CRM-sent one keeps its row.
- Token failure: mailbox `error` (guarded as in 2B-1; Settings asks to reconnect). Other failures: the next scheduled
  run tries again. `last_sync_at`, `message_count` updated after each run.

**Matching (first hit wins), only to leads the user can see:**
1. same conversation as one of the user's linked messages → its lead, contact, company;
2. a counterpart address (sender for received mail, recipients for sent mail) equal to a contact's business email →
   contact, its company, and the most recent open lead of that contact (else of that company), the user's own first;
3. the address domain (not free mail, not the mailbox's own domain) equal to exactly one company's domain → company and
   its open lead when it has exactly one;
4. else Unlinked.

**API (all `use_email`; every query filtered to the caller's own messages):**
- `GET /mail?view=inbox|sent|drafts|archive|unlinked|awaiting|mine&company=&lead=&s=` → newest 200 (list fields and a
  120-character preview). Unlinked = no lead (drafts excluded); Awaiting reply = sent, linked, no later received message
  in the conversation; My leads = linked to a lead assigned to me. Search covers subject, sender, recipients, text.
- `GET /mail/meta` → unread inbox count, unlinked count, companies and leads present in my mail (for the filters), my
  mailbox (address, status, last sync).
- `GET /mail/:id` → the message, attachment names, the linked lead (number, status, priority, next follow-up), contact
  and company names, and the conversation's other messages (when, direction, who). Opening an unread one marks it read.
- `POST /mail/:id/read {isRead}`, `POST /mail/:id/archive` → local change at once, Graph change by job `mail_action`.
- `POST /mail/:id/reply {cc[], body}` and `POST /mail {to, cc[], subject, body, leadId?, companyId?}` → queued like
  2B-1 (`send_user_email`); a reply goes through Graph `reply` so it stays in the conversation. With a lead: the
  "Email sent" history line, New / Not Contacted → Contacted, as in 2B-1.
- `POST /mail/:id/log` → lead history "Email received · {subject}" (or "Email sent · …"), once per message; others
  see only "Email received" / "Email sent".
- `POST /mail/:id/link {leadId}` → the lead, its contact and company. `POST /mail/:id/create-lead` → the prototype's
  "Create lead from this email": company matched by the sender's domain (duplicate check as the lead form), else named
  from the sender; source Other, notes = subject and text, follow-up in 2 days, allocation rules; the message is linked.
- `POST /mail/:id/task` → task "Reply to {sender} · {subject}" due tomorrow, mine, on the linked lead.
- `POST /mailboxes/:id/sync` (owner) → 202. `GET /nav-counts` gains `mailUnread`.

**Email screen (`/email`, `/email/:id`, query `folder`, `company`, `lead`, `s`)** — the prototype layout: topbar
"Email" with "{address} · Microsoft 365 [Connected] · synced {when} · every thread links to a Lead, Contact and
Company" (or "{my email} · [Mailbox not connected]" with Connect Microsoft 365), Sync now, + Compose; the "Show mail
for" bar (Client, Lead, Project greyed, Clear, search); folders Inbox (unread count) / Sent / Drafts / Archive, smart
views Unlinked (count) / Awaiting reply / My leads, Templates (six in my language, each opens Compose filled) and
Manage templates…; message list; reader with Reply, Log as activity, Link to lead / create lead, attachments, and
Suggested actions (Create meeting greyed, Add contact, Add follow-up task; or Create lead from this email); side panel
Linked records, Thread history, Follow-up. Compose = the prototype dialog (Client, Lead, Project greyed, To, Cc, Keep in
the loop, Template, Context saved on, Subject, Message, Discard / Send). Drafts show no Reply or actions ("Drafts are
edited in Outlook."). Sidebar: Email after Contacts with the unread inbox count. The lead's Emails tab lists received
messages too (badge Received; drafts left out).

## Left to the builder

Component split, translation keys (es/fr), Graph request details, migration name, the exact cap values above unless
they prove wrong, tests (API: privacy on every route, matching, sync with a fake Graph, scheduling, reply; e2e: the
Email screen with seeded mail, privacy between two users, log / link / task).
