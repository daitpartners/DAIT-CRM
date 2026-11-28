# Lead mail on the timeline, and one copy per email — design

Date: 28 Nov 2026. Owner: Deepak. Builds on web-mail release 3 (live as `e83f6ea`).

## Why

The owner looked at the KPMG lead (Elaine Reyes): Carlos emailed Elaine from Outlook with Deepak in Cc, Elaine
replied. "Recent on the lead" showed Elaine's reply (Deepak had clicked Log as activity) but not Carlos's email. The
owner wants the timeline to show the whole conversation without anyone clicking anything, because the CRM is how
admins see what the team does with each lead.

While checking, a real bug showed up: the same email is stored twice in one mailbox (225 extra rows on live).

## Owner's decisions (28 Nov 2026)

1. Every lead email, sent or received, from any team mailbox, from Outlook or from the CRM, goes on "Recent on the
   lead" (the lead's timeline) by itself. The lead mail already stored (past 12 months) is added once, in date order.
2. An email a team member sends from Outlook to a New or Not Contacted lead moves it to Contacted, the same rule as
   an email sent from the CRM.
3. Fix the duplicates and remove the 225 extra copies (backup first; counts shown before anything is deleted).

## Findings (live data, 28 Nov)

- The timeline gets an email line only from `recordOnLead` (CRM sends, Mailer, drafts send) or from Log as activity
  (`POST /mail/:id/log`). Synced mail never adds one.
- **Duplicates:** every message stored by the lead-mail backfill (`mail_backfill`, Graph `$search`) has a regular
  Graph id (`AAMk…`, 152 chars) although the request asks for `IdType="ImmutableId"`; delta sync stores immutable ids
  (`AAkALg…`, 68 chars). `storeMessage` matches on `(user_id, graph_id)` only, so a message that both paths see is
  stored twice. Live: 225 groups of exactly 2 rows (same user, same internet message id, same direction), and every
  regular-id row (225) is one of them. 3 rows across all mail are logged or referenced by a timeline line.
  Backfill runs when a lead/contact address is added (it ran at 16:15 today and doubled Elaine's reply in both
  Deepak's and Carlos's mailboxes).

## Approaches considered

- **Translate the search ids to immutable ids** (Graph `translateExchangeIds`): exact, but one more Graph call per
  page, and it may need a permission the app does not have (only Mail.ReadWrite and Mail.Send). Rejected.
- **Recognise a message by its internet message id as well** (chosen): `storeMessage` falls back to
  `(user_id, message_id, direction)` when the Graph id is unknown. Works for every path, no new permission. When the
  incoming copy comes from delta sync (immutable id) and the stored row has the search id, the row takes the delta
  id, so later delta changes and removals find it.
- **Timeline lines written at read time** (compute the timeline from email rows): no data to fill, but every timeline
  read joins mail across mailboxes and "Last activity" and the Overdue/KPI code already read `lead_activities`.
  Rejected; lines are written once, like today's CRM-sent lines.

## Design

### A. One copy per email (bug fix)

- Direction = `received` vs not (`sent`/`draft`/`queued`…): an email sent to yourself has the same internet message id
  in Sent and Inbox; those stay two rows.
- `storeMessage(…)`: not found by Graph id → look for the user's row with the same `message_id` and direction (and a
  Graph id or none). Found → treat as that row (update path). If the caller is delta sync, set the row's `graph_id`
  to the incoming id; if the caller is the backfill (search), keep the row's id.
- One-time clean-up CLI `mail-dedupe` (dry run by default, `--apply`): for each duplicate group keep the
  immutable-id row (delta's), carry over from the other row what it alone has (lead, contact, company, project,
  `logged_at`), point any timeline line, `reply_to_id` and Mailer recipient that references the removed row at the
  kept one, then delete the removed row. Prints counts only (groups, rows removed, links carried, references moved).
  Re-running finds 0.

### B. Lead mail on the timeline by itself

- One line per email per lead, whichever mailboxes hold it. The key is the internet message id; for a CRM-sent email
  whose row has no message id yet (sync has not claimed it), a colleague's copy matches the CRM line by sender,
  subject (without Re:/Fw:) and a few minutes' window, as `claimCrmCopy` does.
- Title: `Email sent · <subject>` when the sender is a CRM user's mailbox address (any team member), else
  `Email received · <subject>`. `occurred_at` = the email's date. `by` = the sending team member for sent mail, none
  (system) for received mail. `related_type`/`related_id` = the row it was made from. Privacy is unchanged
  (`activityRow`): who cannot open that mailbox's mail sees only "Email sent" / "Email received".
- Written when sync or backfill stores a lead-linked email, when a message is linked to a lead (Link to lead,
  including linking a whole conversation), and by Log as activity as today (which now usually answers
  `already_logged`). The row the line was made from gets `logged_at`. Unlinking a message does not remove a line
  (history stays, as today for logged lines).
- Drafts are never logged. Deleted mail keeps its line.
- **Contacted:** a sent line (team member's email) on a New or Not Contacted lead moves it to Contacted
  (`applyStatusChange`, source "Email sent"), the same as `recordOnLead`.

### C. Past mail (one time)

CLI `lead-mail-timeline` (dry run by default, `--apply`), run after `mail-dedupe`: walks every stored lead-linked
email (not drafts, lead not deleted) oldest first and adds the missing lines by the rules in B, dated at the email's
date. Contacted applies to leads still New or Not Contacted that have a sent line. Dry run prints: lines to add, leads
touched, leads that would move to Contacted. Re-running adds 0.

## Not in scope

- Mail not linked to any lead (personal mail is not stored).
- Changing Log as activity for unlinked mail, or removing the button.
- Mexico/Chile lookups, other pending items.

## Left to the builder

File layout, query shape, how the line-dedupe lookup is indexed, test names. Keep the existing patterns
(`storeMessage`, `recordOnLead`, CLIs like `mail-cleanup`).
