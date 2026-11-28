# Lead mail on the timeline, and one copy per email: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each email once per mailbox. Put every lead email (sent or received, from any team mailbox) on the lead's timeline by itself, and move New / Not Contacted leads to Contacted when a team member emails them from Outlook. Provide two one-time CLIs: one removes the 225 duplicates on live, the other fills in past mail.

**Architecture:**
- `storeMessage` (apps/api/src/jobs/handlers/syncMailbox.ts) also matches a stored row by internet message id plus direction. Delta sync passes its immutable id onto such a row.
- A new module, `apps/api/src/mail/leadTimeline.ts`, owns the rule "one timeline line per email per lead". Sync, backfill, Link to lead, Create lead and the fill CLI all call it.
- A new module, `apps/api/src/mail/dedupe.ts`, merges existing duplicate rows. Both CLIs follow the `mail-cleanup` pattern: a dry run by default, `--apply` to change anything, and any unknown argument exits 1.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 on Postgres, vitest (apps/api/test, real test database via `resetDb`), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-28-lead-mail-timeline-design.md`

## Global Constraints

- **Direction:** `status = 'received'` is inbound. Everything else is the outbound side. The same internet message id in both directions (an email to yourself) stays two rows.
- **Line titles:** exactly `Email sent · <subject>` / `Email received · <subject>`. The separator is U+00B7 with a space on each side, as in `recordOnLead`.
- **Sent vs received:** a line is "sent" when the email's `from_address` (lowercased) belongs to a CRM user. That means a personal `email_accounts.address`, a personal account's `send_as`, or `users.email`. Otherwise the line is "received".
- **Line fields:**
  - `by_user_id` is the sending user for sent lines and null for received lines.
  - `occurred_at` is the email's `occurred_at`.
  - `related_type` is `'email_message'` and `related_id` is the row the line was made from.
  - That row gets `logged_at` (only if it is null).
- **Never logged:** drafts (`folder = 'drafts'` or status draft/queued/sending), rows with no `lead_id`, rows with `lead_deleted_at` set.
- **Contacted:** only a sent line moves the lead, and only from `New` or `Not Contacted` to `Contacted`. It goes through `applyStatusChange(tx, lead, 'Contacted', { userId }, { sourceTitle: 'Email sent' })`, the same call `recordOnLead` makes. A received line never changes the stage.
- **Privacy:** `activityRow` in apps/api/src/leads/serialize.ts stays as it is. Logs and CLI output carry ids and counts only, never subjects, bodies or addresses.
- **API process:** stays one process. No new npm dependencies, no new Graph calls, no new Graph permissions. No database migration is expected. If an index is truly needed, add migration 29, adds only.
- **Commit trailers:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GKS9Jmtrg6EmfFh6J9p9ci`. Never commit `Reference/` or unrelated package-lock drift.
- **Tests:** `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London npx vitest run <file>` in apps/api. The full suite is `npm test` at the repo root.

## Review Focus

1. **Same email in two team mailboxes, in either sync order.** Carlos's Sent copy and Deepak's Cc'd Inbox copy give exactly one line: `Email sent`, by Carlos. Tested in Task 3.
2. **CRM-sent email whose colleague's Cc copy syncs before the sender's mailbox claims the CRM row.** The CRM row has no message id yet; the colleague's copy adds no second line. Tested in Task 3.
3. **A search copy is stored first and the delta copy arrives later.** One row, which now carries the delta id. A later delta removal of that id removes the row. Tested in Task 1.
4. **An email to yourself.** The Sent and Inbox copies stay two rows and give one timeline line. Tested in Tasks 1 and 3.
5. **Two mailboxes logging the same email at the same moment.** One line. Each log runs in a transaction holding `pg_advisory_xact_lock` on the lead id. Tested in Task 3 with two concurrent calls.

---

### Task 1: One copy per email in `storeMessage`

**Files:**
- Modify: `apps/api/src/jobs/handlers/syncMailbox.ts` (`storeMessage`, its delta caller around line 253)
- Modify: `apps/api/src/jobs/handlers/mailBackfill.ts:65`
- Test: `apps/api/test/syncMailbox.test.ts` (new `describe('one copy per email (lead mail timeline)')`)

**Interfaces:**
- Produces: `storeMessage(account, user, folder, m, ctx, rules, idSource: 'delta' | 'search' = 'delta'): Promise<StoreResult>`. The backfill passes `'search'`.

- [ ] **Step 1: Write the failing tests** (use the file's existing fake-Graph and factory helpers):
  - `stores a message seen by search and then by delta once, and takes the delta id`: store with graph id `AAMk-search` and `internetMessageId '<m1@x>'` (search), then `AAkALg-delta` with the same internet message id (delta). Expect 1 row for the user with that message id, with `graphId === 'AAkALg-delta'`.
  - `a delta copy first and a search copy later stay one row with the delta id`: expect 1 row, `graphId === 'AAkALg-delta'`, and `storeMessage` returns `'updated'`.
  - `an email to yourself keeps its Sent and Inbox rows`: the same internet message id in folder `sent` (from own address) and `inbox`. Expect 2 rows.
  - `a removal by the delta id removes the row first stored by search`: search copy, then delta copy, then a delta page with `@removed` for `AAkALg-delta`. Expect 0 rows.
  - `two users with the same message keep a row each`: expect 1 row per user.
  - `a message without an internet message id is matched by Graph id only`: two different Graph ids, both with a null internet message id. Expect 2 rows.
- [ ] **Step 2: Run them.** Expect FAIL: rows are duplicated.
- [ ] **Step 3: Implement.**
  - In `storeMessage`, when nothing is found by `(userId, graphId)` and `m.internetMessageId` is set, look up the user's row with the same `messageId` and the same direction (`status: 'received'` vs `status: { not: 'received' }`).
  - If one is found, take the existing update path with it. When `idSource === 'delta'` and that row's `graphId` differs, also set `graphId: m.id`.
  - Leave `claimCrmCopy` as it is, and keep it before the new lookup for outbound mail. A CRM row has `messageId` null until it is claimed.
  - A unique violation on `(user_id, graph_id)` when adopting means another row already has that id. Skip the adoption and return `'updated'`.
- [ ] **Step 4: Run** `npx vitest run test/syncMailbox.test.ts test/mailBackfill.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `fix(mail): one row per email when search and delta give different Outlook ids`.

### Task 2: `mail-dedupe` clean-up of existing duplicates

**Files:**
- Create: `apps/api/src/mail/dedupe.ts`
- Create: `apps/api/src/cli/mail-dedupe.ts`
- Test: `apps/api/test/mailDedupe.test.ts`

**Interfaces:**
- Produces:
  - `parseDedupeArgs(argv: string[]): { apply: boolean } | { error: string }`
  - `DEDUPE_USAGE: string`
  - `dedupeMail(db: PrismaClient, opts: { apply: boolean; log: (line: string) => void }): Promise<DedupeCounts>`
  - `DedupeCounts = { groups: number; removed: number; linksCarried: number; referencesMoved: number }`

- [ ] **Step 1: Write the failing tests:**
  - A group is rows with the same `user_id`, the same non-null `message_id` and the same direction, with more than one row.
  - `keeps the delta row (AAkALg id) and removes the search row`: expect `removed: 1` and the kept id is the `AAkALg…` row. When neither or both ids start with `AAkALg`, keep the lowest id.
  - `carries lead, contact, company, project and logged_at from the removed row when the kept row has none`: the kept row ends with the removed row's values, and `linksCarried` counts rows that gained anything. Values the kept row already has win.
  - `moves timeline lines, replies and Mailer recipients to the kept row`: these are a `lead_activities` row with `related_type 'email_message'` and `related_id = removed.id`, an `email_messages.reply_to_id = removed.id`, and an `email_campaign_recipients.email_message_id = removed.id`. All three point at the kept id, and `referencesMoved` is 3.
  - `a dry run changes nothing and reports the same counts`.
  - `a second run finds 0 groups`.
  - `the same message id in Sent and Inbox is not a group`.
  - `parseDedupeArgs`: `[]` and `['--dry-run']` give apply false, `['--apply']` gives true, `['--aply']` gives an error.
- [ ] **Step 2: Run them.** Expect FAIL: the module is missing.
- [ ] **Step 3: Implement.** Use one transaction per group. The log prints one summary line: `mail-dedupe: <dry run|applied> groups=N removed=N links_carried=N references_moved=N`. The CLI mirrors `apps/api/src/cli/mail-cleanup.ts`.
- [ ] **Step 4: Run** `npx vitest run test/mailDedupe.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(mail): mail-dedupe merges the duplicate rows search and sync left`.

### Task 3: One timeline line per lead email (`leadTimeline.ts`) and its callers

**Files:**
- Create: `apps/api/src/mail/leadTimeline.ts`
- Modify: `apps/api/src/jobs/handlers/syncMailbox.ts` (after a row is stored with a lead)
- Modify: `apps/api/src/routes/mail.ts`: `/mail/:id/link`, `linkConversation`, `/mail/:id/create-lead`, `/mail/:id/log`
- Modify: `apps/api/src/mail/outgoing.ts`: export the Contacted set, `CONTACTED_ON_EMAIL`, so both places share it
- Test: `apps/api/test/leadTimeline.test.ts`; adjust `apps/api/test/mail*.test.ts` where Log as activity now answers `already_logged`

**Interfaces:**
- Consumes: Task 1's `storeMessage`.
- Produces:
  - `teamSenders(db): Promise<Map<string, number>>`: a lowercased address mapped to a user id, per the Global Constraints.
  - `logLeadMail(db: PrismaClient, emailMessageId: number, opts?: { senders?: Map<string, number>; contacted?: boolean }): Promise<'logged' | 'already' | 'skipped'>`.
    - It opens its own transaction and takes `pg_advisory_xact_lock(lead_id)`.
    - `contacted` defaults to true.
    - Task 4 calls it with a shared `senders` map.

- [ ] **Step 1: Write the failing tests:**
  - `a lead email in Carlos's Sent adds "Email sent · <subject>" by Carlos, dated at the email`: check title, `byUserId`, `occurredAt`, `relatedId`, and that `loggedAt` is set.
  - `a lead's reply in Deepak's Inbox adds "Email received · <subject>" with no author`.
  - `Carlos's Sent copy and Deepak's Cc copy give one line, whichever is logged first`: run both orders. Expect 1 line, `Email sent`, by Carlos.
  - `a CRM-sent email (recordOnLead line, no message id yet) and a colleague's Cc copy give one line`: the colleague's copy has the same from address, a subject differing only by `Re: `, and is within the claim window. Expect 1 line.
  - `an email to yourself gives one line`.
  - `a draft, a row without a lead, and a row whose lead was deleted are skipped`.
  - `a sent line moves New and Not Contacted to Contacted; a received line and a Qualified lead do not`.
  - `two concurrent logLeadMail calls for two copies of one email add one line`.
  - `sync stores a lead email from Outlook and its line appears`: end to end through `storeMessage` with the fake Graph.
  - `Link to lead adds the line for the message and for the conversation it links`.
  - `Log as activity on an auto-logged message answers 409 already_logged`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - **Already logged when:** a `lead_activities` row on the same lead with `activity_type 'email'` and `related_type 'email_message'` already points at a row of the same email. "Same email" means:
    - the same row; or
    - the same non-null `message_id` and the same "sent" decision; or
    - for a CRM row (`source 'crm'`, `message_id` null): the same from address, the same `baseSubject`, and `occurred_at` within `CLAIM_WINDOW_MS`. Export both helpers from where `claimCrmCopy` gets them.
  - **Sync call:** call `logLeadMail` after `storeMessage` creates a row with a lead. A failure there is logged by id and never fails the sync.
  - **Log as activity:** `/mail/:id/log` keeps its own answers (`no_lead`, `already_logged`) but uses the same "already logged" check, so a copy in another mailbox counts. Its line keeps the logging user as `by`, as today.
- [ ] **Step 4: Run** `npx vitest run test/leadTimeline.test.ts test/syncMailbox.test.ts test/mailBackfill.test.ts`, then the mail route tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(mail): every lead email goes on the lead's timeline once, by itself`.

### Task 4: `lead-mail-timeline` fill for past mail, and the runbook

**Files:**
- Create: `apps/api/src/mail/timelineFill.ts`
- Create: `apps/api/src/cli/lead-mail-timeline.ts`
- Test: `apps/api/test/timelineFill.test.ts`
- Modify: `docs/DEPLOYMENT.md` (a new section, "Lead mail timeline: deploy runbook", plus entries under "One-time steps after a release")
- Modify: `docs/PENDING.md`

**Interfaces:**
- Consumes: `logLeadMail` and `teamSenders` from Task 3.
- Produces:
  - `parseFillArgs(argv)`, with the same contract as `parseDedupeArgs`
  - `FILL_USAGE: string`
  - `fillLeadMailTimeline(db, opts: { apply: boolean; log }): Promise<{ examined: number; lines: number; leads: number; contacted: number }>`

- [ ] **Step 1: Write the failing tests:**
  - `adds the missing lines oldest first and reports counts`: with 3 lead emails (one already logged), expect `lines: 2`.
  - `the dry run reports lines, leads and Contacted moves without writing`: the dry run must predict the same counts as `--apply`, including duplicates across mailboxes counted once. Implement the dry run by running the same logic inside a transaction that is rolled back.
  - `a second run adds 0`.
  - `skips drafts and deleted-lead mail`.
  - `parseFillArgs` cases, as in Task 2.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - Walk lead-linked rows ordered by `occurred_at, id`, in batches of 200.
  - The log line is `lead-mail-timeline: <dry run|applied> examined=N lines=N leads=N contacted=N`.
  - The runbook follows "Deploying a release to live", backup named `dait_crm-pre-lead-mail-timeline.dump`, in this order:
    1. Install.
    2. `mail-dedupe` dry run, then show the owner the counts (expected about 225 groups).
    3. `--apply`.
    4. `lead-mail-timeline` dry run, then show the owner the counts.
    5. `--apply`.
    6. Check the KPMG lead shows Carlos's email.
    7. Rollback: release `e83f6ea` runs fine against the changed data (no schema change).
- [ ] **Step 4: Run** `npx vitest run test/timelineFill.test.ts`, then the full `npm test` at the repo root. Expect PASS, apart from the known flakes listed in docs/PENDING.md.
- [ ] **Step 5: Commit** `feat(mail): lead-mail-timeline fills past lead mail onto timelines; runbook`.
