# Web mail release 1 (lead mail only, team visibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CRM stores only lead mail (filtered at sync, cleaned up once, backfilled 12 months), links it to its lead whoever owns the lead, and lets Administrators and Managers read every user's lead mail, view only, through a "Mail of:" picker on the existing Email screen.

**Architecture:** One rules module (`mail/leadMail.ts`) decides "is this lead mail" for sync, backfill and clean-up. Sync keeps its per-folder Graph delta (Deleted Items added, 12-month start) and drops non-lead messages before anything is written. A new `mail_backfill` job chain works through a `mail_backfills` table (one row per mailbox × lead/contact address) fed by a worker sweep that notices new addresses. One access module (`mail/access.ts`) scopes every mail query and refuses changes to another user's mailbox. The web change is limited to the picker, view-only states, the restricted lead chip and a Deleted items folder.

**Tech Stack:** Fastify 5, Prisma 6 / Postgres, Microsoft Graph (delegated Mail.ReadWrite, already consented), vitest, React + Vite + TanStack Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-web-mail-email-design.md` (release 1 = "sync scope + clean-up + visibility"). Mockup state 5: `docs/superpowers/mockups/2026-11-26-outlook-mail.html`.

## Global Constraints

- Release 1 only. No new screen layout, flags, Move/Delete actions, attachment download, search filters (release 2); no compose page, schedule send, undo, follow-up box, task priority/note (release 3).
- A message is lead mail when any of From, To, Cc, Bcc is a lead or contact address (trimmed, lower-cased) or an address at the own domain of a lead's company; free mail (`isFreeMail`, shared `FREE_MAIL_DOMAINS` in `packages/shared/src/normalise.ts`, the "one shared place"), shared hosts (`isSharedHost`), `daitpartners.com` and every connected mailbox's own domain never count.
- "A conversation counts": a message whose conversation (same user, same `threadId`) already has a row with `leadId` set is kept.
- Archived and closed leads count. Deleted leads do not; their stored mail is kept, unlinked, private to its owner, and exempt from clean-up.
- Checked when stored only: once kept a message stays; contact/domain changes never delete stored mail.
- Linking ignores lead visibility: among matching leads, open first (status not in `CLOSED_STATUSES`), then most recently active = `updatedAt` desc, then `id` desc.
- Windows: initial sync of a new mailbox `INITIAL_DAYS = 365`; backfill `BACKFILL_DAYS = 365`.
- Synced folders: Inbox, Sent, Drafts, Archive, Deleted items (Graph `deleteditems` → CRM folder `deleted`).
- Who sees what: Administrator and Manager (new right `view_team_mail`) read every user's lead mail, view only; Sales representative and Data research user see their own only. Enforced on the server on every mail route.
- View only in another user's mailbox: no reply, read/unread, archive, link, create-lead; opening never marks read and queues no `mail_action`. Allowed: read, Log as activity, Add follow-up task, open lead.
- Team-readable mail of another user = folder ≠ `drafts`, `leadDeletedAt` null, and at least one of `leadId`, `contactId`, `companyId` set.
- Audit an Administrator/Manager opening another user's message: who, message id, when; never subject, body or addresses.
- Logs (clean-up, backfill, sync) carry ids and counts only, never subject, body or addresses of mail.
- UI copy (exact, en; es/fr translations required by `npm run i18n:check`): `Mail of:`, `Me`, `Everyone`, `Administrators and managers. Team mail is view only.`, `View only — {name}'s mailbox` (first name), `You can read, log and create tasks; only {name} can reply from this mailbox.`, `Team view · lead mail of {who}`, `everyone`, `View only`, `for other mailboxes`, `{lead} · another owner's lead`, `Deleted items`, `Only mail with your leads and contacts is shown here`, `Why?`, `What the CRM keeps`, `Mail to and from your leads' and contacts' addresses.`, `Mail from a lead company's own domain (not gmail.com, outlook.com and similar).`, `The past 12 months are fetched when a lead is added.`, `Personal and other work mail stays in Outlook only.`, `{name}'s mailbox`.
- No new npm dependency. No new Microsoft permission. Dates 24-hour in the viewer's time zone.
- Every command runs with `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London` from the repo root `~/Documents/DAIT-CRM/CRM-DAIT`. Unit DB `dait_crm_unit` (vitest default), e2e DB `dait_crm_e2e` (start-server.sh). After changing `packages/shared`, run `npm run build -w packages/shared` before api/web tests.
- Commits on branch `web-mail` end with the two trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GKS9Jmtrg6EmfFh6J9p9ci`. Deploy only on the owner's "deploy", backup first.

## Review Focus

1. A lead company whose website is on a shared host (wixsite.com, facebook.com page) or free mail: that host must never become a lead domain, or everyone's personal mail from it is stored. Test in Task 2.
2. Addresses typed with capitals or spaces on a lead/contact (`"  Ana@ACME.com "`) must still match mail from `ana@acme.com`, in the filter and in linking. Test in Task 2 (and Task 3).
3. Graph throttling (429) mid-backfill must not fail rows or spin: the row goes back to queued and the chain waits for Retry-After. Test in Task 7.
4. An Administrator opening another user's unread message (including the automatic first-message preview) must leave it unread in the CRM and in Outlook, and the audit row must hold no content. Test in Task 8.
5. Running the clean-up twice, or as a dry run, or while a CRM send is still queued: second run removes 0, dry run removes nothing, queued/sending rows stay. Test in Task 5.

---

### Task 1: Schema, right and lead-delete marker

**Files:**
- Modify: `prisma/schema.prisma` (EmailMessage, EmailAccount; new models)
- Create: `prisma/migrations/20261212100000_web_mail_lead_only/migration.sql` (generated)
- Modify: `packages/shared/src/rights.ts`
- Modify: `apps/api/src/audit.ts` (`AuditEntry.action` gains `'view'`)
- Modify: `apps/api/src/leads/delete.ts` (`apply`)
- Modify: `docs/MIGRATIONS.md`, `docs/data-model.md`
- Test: `packages/shared/test/roles.test.ts`, `apps/api/test/leadDelete.test.ts`, `apps/web/test/leadDelete.test.tsx` (admin fixture rights)

**Interfaces:**
- Produces: `EmailMessage.leadDeletedAt: Date | null` (`lead_deleted_at`); model `MailBackfill` (`mail_backfills`): `id Int`, `accountId Int` (FK email_accounts, cascade), `address String @db.VarChar(320)` (lower-cased), `status String @default("queued")` (`queued|running|done|failed|skipped`), `nextLink String?`, `found Int @default(0)`, `stored Int @default(0)`, `attempts Int @default(0)`, `lastError String?`, `finishedAt DateTime?`, `createdAt`, `updatedAt`; `@@unique([accountId, address])`, `@@index([status, id])`. Model `MailBackfillAddress` (`mail_backfill_addresses`): `address String @id @db.VarChar(320)`, `firstSeenAt DateTime @default(now())`. Right `'view_team_mail'` (Administrator and Manager through `ACTIONS`; not in `ADMIN_ONLY`). Audit action `'view'`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/roles.test.ts
test('view_team_mail: Administrators and Managers only', () => {
  expect(can('Administrator', 'view_team_mail')).toBe(true);
  expect(can('Manager', 'view_team_mail')).toBe(true);
  expect(can('Sales Representative', 'view_team_mail')).toBe(false);
  expect(can('Data Research User', 'view_team_mail')).toBe(false);
});
// apps/api/test/leadDelete.test.ts
it('mail of a removed lead stays with its owner, unlinked, marked lead_deleted_at; other mail is untouched', async () => {
  // a synced message on the lead and one on another lead; delete the first lead
  expect(kept).toMatchObject({ userId: rep.id, leadId: null, leadDeletedAt: expect.any(Date) });
  expect(other.leadDeletedAt).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/shared -- test/roles.test.ts && npm test -w apps/api -- test/leadDelete.test.ts`
Expected: FAIL (`view_team_mail` not an Action; `leadDeletedAt` unknown).

- [ ] **Step 3: Change the schema and generate the migration**

Add the fields and models above (`EmailAccount.backfills MailBackfill[]`; update the `EmailMessage.folder` comment to include `'deleted'` and the model comment: "Lead mail only (web-mail release 1); Administrators and Managers read it view only"). Run `npm run db:migrate -w apps/api -- --name web_mail_lead_only`, then rename the folder to `20261212100000_web_mail_lead_only`; check the SQL only adds.

- [ ] **Step 4: Add the right, the audit action, and the marker in `apply(tx, user, planned)`**

Before `tx.lead.deleteMany`, `tx.emailMessage.updateMany({ where: { leadId: { in: leadIds } }, data: { leadDeletedAt: new Date() } })`. Update the file header comment ("unlinked and marked `lead_deleted_at`"). Add `'view_team_mail'` to `apps/web/test/leadDelete.test.tsx` admin rights and any manager fixture that lists all rights.

- [ ] **Step 5: Run the tests**

Run: `npm run build -w packages/shared && npm test -w packages/shared && npm test -w apps/api -- test/leadDelete.test.ts`
Expected: PASS.

- [ ] **Step 6: Document and commit**

`docs/MIGRATIONS.md` row 26: `20261212100000_web_mail_lead_only` | `email_messages.lead_deleted_at`; tables `mail_backfills` (one row per mailbox × lead/contact address: status, next link, found/stored counts, attempts, last error; unique mailbox + address) and `mail_backfill_addresses` (addresses already queued) | Web mail release 1 (not yet released). Add both tables and the column to `docs/data-model.md`.

```bash
git add prisma packages/shared apps/api/src/audit.ts apps/api/src/leads/delete.ts apps/api/test/leadDelete.test.ts apps/web/test/leadDelete.test.tsx docs/MIGRATIONS.md docs/data-model.md
git commit -m "feat(mail): schema for lead-only mail, view_team_mail right, deleted-lead mail marker"
```

---

### Task 2: Lead-mail rules

**Files:**
- Create: `apps/api/src/mail/leadMail.ts`
- Test: `apps/api/test/leadMail.test.ts`

**Interfaces:**
- Produces:
  - `export const OWN_MAIL_DOMAINS: readonly string[] = ['daitpartners.com']`
  - `export interface LeadMailRules { addresses: ReadonlySet<string>; domains: ReadonlySet<string> }`
  - `export async function loadLeadMailRules(db: Db): Promise<LeadMailRules>` — addresses = every `leads.business_email` and `contacts.business_email` (all leads incl. archived/closed, all contacts); domains = `companies.domain` of companies with ≥1 lead, plus `domainOf` of those leads' addresses and of contacts of those companies; minus free mail, shared hosts, `OWN_MAIL_DOMAINS` and the domains of every `email_accounts.address` / `send_as`. Two or three `findMany` with `select`, no per-row queries.
  - `export function participantsOf(m: { from: string | null; to: string[]; cc: string[]; bcc: string[] }): string[]` (trimmed, lower-cased, unique, empty dropped)
  - `export function isLeadMail(rules: LeadMailRules, participants: string[]): boolean`
  - `export async function inLeadConversation(db: Db, userId: number, threadId: string | null): Promise<boolean>` (a row of `userId` with that `threadId` and `leadId` not null)

- [ ] **Step 1: Write the failing tests**

```ts
test('an address on a lead or a contact counts, whatever its case or spaces (Review Focus 2)', async () => {
  // lead businessEmail '  Ana@ACME.com ', contact of a company with no lead 'bo@solo.io'
  const rules = await loadLeadMailRules(prisma);
  expect(isLeadMail(rules, participantsOf({ from: 'ana@acme.com', to: [], cc: [], bcc: [] }))).toBe(true);
  expect(isLeadMail(rules, ['bo@solo.io'])).toBe(true);
});
test("a lead company's own domain counts (website, or its lead/contact addresses), archived and closed leads included", ...
  expect(isLeadMail(rules, ['colleague@acme.com'])).toBe(true); // via website
  expect(isLeadMail(rules, ['x@nosite.co'])).toBe(true);        // company without website, lead address j@nosite.co
  expect(isLeadMail(rules, ['y@archived-co.com'])).toBe(true);
test('a company with no lead lends no domain; its contacts count only by exact address', ...
  expect(isLeadMail(rules, ['other@solo.io'])).toBe(false);
test('free mail, shared hosts, daitpartners.com and connected mailboxes\' domains never count (Review Focus 1)', ...
  // lead with gmail address; company website https://acme.wixsite.com/x; mailbox maya@daitpartners.com, sendAs info@dait.example
  expect(isLeadMail(rules, ['someone@gmail.com'])).toBe(false);
  expect(isLeadMail(rules, ['someone@wixsite.com'])).toBe(false);
  expect(isLeadMail(rules, ['deepak@daitpartners.com'])).toBe(false);
  expect(isLeadMail(rules, ['ops@dait.example'])).toBe(false);
  expect(isLeadMail(rules, ['someone@gmail.com', 'pat@acme.com'])).toBe(true); // any participant
test('inLeadConversation: only the same user\'s lead-linked row in that conversation', ...
  expect(await inLeadConversation(prisma, rep.id, 'conv-1')).toBe(true);
  expect(await inLeadConversation(prisma, other.id, 'conv-1')).toBe(false);
  expect(await inLeadConversation(prisma, rep.id, null)).toBe(false);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/leadMail.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module** with the signatures above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/leadMail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/leadMail.ts apps/api/test/leadMail.test.ts
git commit -m "feat(mail): lead-mail rules (lead/contact addresses, lead company domains, conversation)"
```

---

### Task 3: Linking ignores lead visibility

**Files:**
- Modify: `apps/api/src/mail/match.ts`
- Test: `apps/api/test/mailMatch.test.ts` (rewrite the visibility cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `matchMail(db: Db, user: AuthUser, m: { threadId: string | null; counterparts: string[]; ownAddress: string }): Promise<MailLinks>` (same signature; `user` now only scopes the conversation lookup). Order, first hit wins: (1) the user's own linked conversation, returned as stored (lead kept even if no longer visible); (2) a lead whose `businessEmail` equals an address (case-insensitive) → that lead, its company and contact; (3) a contact's address → contact, company, lead = `pickLead({ contactId })` ?? `pickLead({ companyId })`; (4) a domain (not free mail, shared host, `OWN_MAIL_DOMAINS`, or `ownAddress`'s domain): company with that `domain`, else the company of a lead whose address ends `@domain`; lead = `pickLead({ companyId })`. `async function pickLead(db, where): Promise<number | null>` orders open first, then `updatedAt` desc, `id` desc, archived and closed included, no `leadWhere`.

- [ ] **Step 1: Write the failing tests** (replace "a lead the user cannot see is never linked" and "thread link to a lead the user cannot see keeps company and contact but no lead")

```ts
test("a lead's own email links that lead even when the user cannot see it", async () => {
  // lead assigned to another rep, businessEmail 'Ana@Acme.com'
  expect(await matchMail(prisma, rep, { threadId: null, counterparts: ['ana@acme.com'], ownAddress: OWN })).toEqual({ leadId: lead.id, contactId: lead.contactId, companyId: lead.companyId });
});
test('several leads match: an open one before a closed or archived one, then the most recently updated', ...
  expect(links.leadId).toBe(openNewer.id);
test("a contact's email links the contact, the company and the contact's lead, else the company's", ...
test('a domain known only from a lead address (company without website) links that company and lead', ...
test('free mail, shared hosts, daitpartners.com and the mailbox domain never match a company', ...
test('a conversation the user already linked keeps its lead after the lead moved to someone else', ...
  expect(links.leadId).toBe(lead.id);
// keep: "another user's linked conversation is not used"
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailMatch.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block; update the doc comment (release 1: visibility ignored).

- [ ] **Step 4: Run the match, mail and sync tests**

Run: `npm test -w apps/api -- test/mailMatch.test.ts test/mail.test.ts test/syncMailbox.test.ts`
Expected: PASS (a `mail.test.ts` assertion that relied on "own lead first" is updated to the open/most-recent rule, nothing else).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/match.ts apps/api/test/mailMatch.test.ts apps/api/test/mail.test.ts
git commit -m "feat(mail): link mail to its lead whoever owns it (open first, then most recently active)"
```

---

### Task 4: Sync stores lead mail only; Deleted Items; 12 months; Bcc

**Files:**
- Modify: `apps/api/src/graph/client.ts` (`MailFolder`, `SYNC_FIELDS`, `GraphMessage.bcc`, `toMessage`)
- Modify: `apps/api/src/jobs/handlers/syncMailbox.ts`
- Modify: `apps/api/test/helpers.ts` (nothing yet; Task 6 adds fakes)
- Test: `apps/api/test/syncMailbox.test.ts`, `apps/api/test/graphClient.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadLeadMailRules`, `participantsOf`, `isLeadMail`, `inLeadConversation`; Task 3 `matchMail`.
- Produces:
  - `MailFolder = 'inbox' | 'sentitems' | 'drafts' | 'archive' | 'deleteditems'`; `GraphMessage.bcc: string[]` (from `bccRecipients`, lower-cased).
  - `export const FOLDERS` (now exported) with `{ graph: 'deleteditems', folder: 'deleted' }` last; `export const INITIAL_DAYS = 365`.
  - `export type StoreResult = 'stored' | 'updated' | 'claimed' | 'skipped'`
  - `export async function storeMessage(account: EmailAccount, user: AuthUser, folder: string, m: GraphMessage, ctx: JobContext, rules: LeadMailRules): Promise<StoreResult>` — an existing row is updated as today (no filter); a CRM copy is claimed as today; otherwise skipped unless `isLeadMail(rules, participantsOf({ from: m.from?.address ?? null, to: m.to, cc: m.cc, bcc: m.bcc }))` or `inLeadConversation(prisma, user.id, m.conversationId)`. A skipped message writes nothing (no attachment-name call, no body processing). New rows store `bccAddresses: m.bcc`. `counterparts` for `matchMail`: outbound `[...to, ...cc, ...bcc]`, inbound `[from, ...cc]`.
  - `syncMailboxHandler` loads `rules` once per run and passes them down.

- [ ] **Step 1: Make the existing sync tests seed lead mail**

In `syncMailbox.test.ts` `beforeEach`, create company Acme (`website: 'https://acme.com'`), contact `ana@acme.com` and a lead on it, so the default `msg()` sender is lead mail; any test whose messages have no lead participant gets one added, assertions unchanged.

- [ ] **Step 2: Write the failing tests**

```ts
test('mail with no lead participant is not stored, not counted and costs no attachment call', async () => {
  // from 'friend@gmail.com' to ADDRESS, hasAttachments true
  expect(await prisma.emailMessage.count()).toBe(0);
  expect(attachmentCalls).toBe(0);
  expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).messageCount).toBe(0);
});
test('kept when From, To, Cc or Bcc is a lead/contact address or at a lead company domain', ...
  // four messages, one per field; bcc case in sentitems with bcc ['ana@acme.com']
  expect(rows.map((r) => r.subject).sort()).toEqual(['bcc', 'cc', 'domain', 'to']);
  expect(bccRow.bccAddresses).toEqual(['ana@acme.com']);
test('an internal forward in a conversation that already has a lead-linked message is kept', ...
test('colleague-only mail at daitpartners.com is not stored', ...
test('Deleted Items is read as a fifth folder; a message moved there from Inbox keeps its row with folder deleted', ...
  expect(seen.some((u) => u.includes('/mailFolders/deleteditems/messages/delta'))).toBe(true);
  expect(row.folder).toBe('deleted');
test('a new mailbox starts 365 days back', ...
  expect(new Date(filterSince(seen[0]!)).getTime()).toBeCloseTo(Date.now() - 365 * 86_400_000, -5);
test('a stored row whose contact email changed since is still updated, never removed', ...
// graphClient.test.ts
test('deltaStartUrl asks for bccRecipients; deltaPage maps them lower-cased', ...
  expect(page.messages[0]!.bcc).toEqual(['hidden@acme.com']);
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -w apps/api -- test/syncMailbox.test.ts test/graphClient.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 4: Implement** the Interfaces block; update the handler doc comment ("lead mail only; 12 months; five folders").

- [ ] **Step 5: Run to verify they pass**

Run: `npm test -w apps/api -- test/syncMailbox.test.ts test/graphClient.test.ts test/mail.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/graph/client.ts apps/api/src/jobs/handlers/syncMailbox.ts apps/api/test/syncMailbox.test.ts apps/api/test/graphClient.test.ts
git commit -m "feat(mail): sync stores lead mail only, reads Deleted Items, starts 12 months back, keeps Bcc"
```

---

### Task 5: One-off release clean-up

**Files:**
- Create: `apps/api/src/mail/cleanup.ts`
- Create: `apps/api/src/cli/mail-cleanup.ts`
- Modify: `docs/DEPLOYMENT.md` ("One-time steps after a release": Web mail release 1, clean-up part)
- Test: `apps/api/test/mailCleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 `leadDeletedAt`, audit `'view'` not used here (action `'delete'`); Task 2 rules.
- Produces:
  - `export interface CleanupReport { dryRun: boolean; users: { userId: number; name: string; checked: number; kept: number; removed: number }[]; removed: number }`
  - `export async function cleanUpNonLeadMail(db: PrismaClient, opts: { dryRun: boolean; log: (line: string) => void }): Promise<CleanupReport>` — per user, by id cursor in batches of 500. A row is **kept** when any of: `leadId` set; `leadDeletedAt` set; `status` in `queued`/`sending`; `campaignId` or `projectId` set; referenced by `quotations.sending_message_id` or `email_campaign_recipients.email_message_id`; `isLeadMail(rules, participantsOf(from_address, to, cc, bcc))`; `threadId` in that user's set of threads that have a lead-linked row. Others are deleted (`deleteMany` by id; bodies are columns, no files exist per message). Then each personal account's `messageCount` is recomputed, and one audit row `{ entityType: 'mail_cleanup', entityId: 'release-1', action: 'delete', userId: null, after: { users: [{ userId, removed }], removed } }` is written (not on dry run). `log` gets one line per user: `mail cleanup: user <id> (<name>): checked N, kept N, removed N` and a total line.
  - CLI `apps/api/src/cli/mail-cleanup.ts`: `--dry-run` flag; prints the report lines; disconnects Prisma (pattern of `cli/fill-company-timezones.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
it('removes non-lead mail of every user, keeps lead mail, logs counts per user only', async () => {
  const lines: string[] = [];
  const r = await cleanUpNonLeadMail(prisma, { dryRun: false, log: (l) => lines.push(l) });
  expect(r.users.find((u) => u.userId === rep.id)).toMatchObject({ checked: 3, kept: 2, removed: 1 });
  expect(await prisma.emailMessage.findUnique({ where: { id: personal.id } })).toBeNull();
  expect(lines.join('\n')).not.toMatch(/Dinner on Friday|friend@gmail\.com|acme\.com/);
});
it('keeps lead-linked, deleted-lead, queued/sending, campaign, quotation, project-tagged and lead-conversation mail', ...
  expect(await prisma.emailMessage.count()).toBe(7);
it('a dry run counts but removes nothing and writes no audit row (Review Focus 5)', ...
it('running it again removes nothing more (Review Focus 5)', ...
  expect((await cleanUpNonLeadMail(prisma, { dryRun: false, log: () => {} })).removed).toBe(0);
it("updates each mailbox's message count and writes one audit row with counts and no content", ...
  expect(JSON.stringify(entry.after)).not.toMatch(/subject|@/);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailCleanup.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `cleanup.ts` and the CLI per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailCleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Runbook text and commit**

`docs/DEPLOYMENT.md`, under "One-time steps after a release", **Web mail release 1 — clean-up** (after the release is live, so sync no longer stores non-lead mail): `cd ~/live/current/apps/api && node --env-file=$HOME/live/shared/.env dist/cli/mail-cleanup.js --dry-run`, check per-user counts look sane, then run without `--dry-run`; safe to run again (removes 0); mail stays in Outlook; restoring means the pre-release dump.

```bash
git add apps/api/src/mail/cleanup.ts apps/api/src/cli/mail-cleanup.ts apps/api/test/mailCleanup.test.ts docs/DEPLOYMENT.md
git commit -m "feat(mail): one-off clean-up of stored mail that is not lead mail"
```

---

### Task 6: Graph search by address and folder ids

**Files:**
- Modify: `apps/api/src/graph/client.ts`
- Modify: `apps/api/test/helpers.ts` (`fakeGraph` gains `searchPage`, `folderIds` as unexpected)
- Test: `apps/api/test/graphClient.test.ts`

**Interfaces:**
- Produces:
  - `export function searchStartUrl(address: string, since: Date): string` → `${GRAPH}/me/messages?$search="participants:<address> AND received>=<YYYY-MM-DD>"&$select=<SYNC_FIELDS>,parentFolderId&$top=50`; `"` and `\` removed from the address before quoting.
  - `export interface SearchPage { items: { folderId: string; message: GraphMessage }[]; nextLink?: string }`
  - `GraphClient.searchPage(account: EmailAccount, url: string): Promise<SearchPage>` — refuses non-Graph links (`not_a_graph_link`); Prefer `IdType="ImmutableId", outlook.body-content-type="html"`; mail scopes.
  - `GraphClient.folderIds(account: EmailAccount): Promise<Record<MailFolder, string>>` — `GET /me/mailFolders/<wellKnown>?$select=id` for the five folders, same Prefer header.

- [ ] **Step 1: Write the failing tests**

```ts
test('searchStartUrl searches the whole mailbox for the address since a date, with the sync fields and parentFolderId', () => {
  const q = new URL(searchStartUrl('Ana@acme.com"', new Date('2025-11-26T00:00:00Z'))).searchParams;
  expect(q.get('$search')).toBe('"participants:ana@acme.com AND received>=2025-11-26"');
  expect(q.get('$select')!.split(',')).toEqual(expect.arrayContaining(['bccRecipients', 'parentFolderId', 'body']));
});
test('searchPage maps messages with their folder id and the next link, immutable ids and HTML bodies', ...
test('searchPage refuses a link that is not Graph', ...
test('folderIds reads the five well-known folders', ...
  expect(Object.keys(ids).sort()).toEqual(['archive', 'deleteditems', 'drafts', 'inbox', 'sentitems']);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/graphClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/graphClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/graph/client.ts apps/api/test/helpers.ts apps/api/test/graphClient.test.ts
git commit -m "feat(graph): search a mailbox by participant address; well-known folder ids"
```

---

### Task 7: Backfill (release and per new address)

**Files:**
- Create: `apps/api/src/mail/backfill.ts`
- Create: `apps/api/src/jobs/handlers/mailBackfill.ts`
- Create: `apps/api/src/cli/mail-backfill.ts`
- Modify: `apps/api/src/jobs/types.ts` (`'mail_backfill'` in `JobType`, `JOB_TYPES`; `MailBackfillPayload = Record<string, never>`)
- Modify: `apps/api/src/worker.ts` (handler; `'mail_backfill'` on the `mail` lane; `sweepMailBackfill()` in `schedule`)
- Modify: `docs/DEPLOYMENT.md` (backfill part of the release step)
- Test: `apps/api/test/mailBackfill.test.ts`, `apps/api/test/workerLanes.test.ts` (lane list)

**Interfaces:**
- Consumes: Task 1 models; Task 4 `storeMessage`, `FOLDERS`, `StoreResult`; Task 6 `searchStartUrl`, `searchPage`, `folderIds`; `mailUser` from `mail/match.ts`; `enqueue`, `STALE_AFTER_MS` from `jobs/queue.ts`.
- Produces (`mail/backfill.ts`):
  - `export const BACKFILL_DAYS = 365; export const BACKFILL_PAGES = 5; export const BACKFILL_GAP_MS = 10_000; export const BACKFILL_MAX_ATTEMPTS = 3; export const THROTTLE_MIN_MS = 60_000;`
  - `export async function queueNewAddressBackfills(db: Db): Promise<number>` — lead/contact addresses (lower(trim), containing `@`) not yet in `mail_backfill_addresses` are inserted there and get one `mail_backfills` row per personal mailbox that is connected, `syncMail`, of an active user (`createMany skipDuplicates`); returns rows created. The first run after deploy is the release backfill. A new mailbox gets no rows (its 12-month initial sync covers it).
  - `export async function ensureBackfillJob(db: Db): Promise<boolean>` — enqueues `mail_backfill` (maxAttempts 1) when rows are queued and no such job is queued or running (non-stale).
  - `export async function sweepMailBackfill(db: Db = prisma): Promise<void>` — rows `running` with `updatedAt` older than `STALE_AFTER_MS` back to `queued`; `queueNewAddressBackfills`; `ensureBackfillJob`.
  - `export async function backfillStatus(db: Db): Promise<{ byStatus: Record<string, number>; found: number; stored: number; mailboxes: { accountId: number; address: string; byStatus: Record<string, number> }[] }>` (mailbox addresses only, never lead addresses).
  - `export async function retryBackfills(db: Db): Promise<number>` — `failed` and `skipped` → `queued`, attempts 0.
- Produces (`jobs/handlers/mailBackfill.ts`): `export async function mailBackfillHandler(job: Job, ctx: JobContext): Promise<void>` — claims the lowest-id `queued` row (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING id`); mailbox not connected / sync off / user inactive → `skipped`; else reads up to `BACKFILL_PAGES` pages from `nextLink ?? searchStartUrl(address, now − BACKFILL_DAYS)`, maps each item's `folderId` through `folderIds` to the CRM folder of `FOLDERS` (others skipped), `storeMessage(...)` with rules loaded once; adds to `found`/`stored` (`stored` counts `'stored'`); more pages → back to `queued` with `nextLink`; finished → `done`, `finishedAt`. GraphError 429 → row `queued` unchanged, next job at `max(Retry-After, THROTTLE_MIN_MS)`; auth failure → row `skipped`, `lastError 'mailbox_needs_reconnect'`; other errors → `attempts+1`, `failed` at `BACKFILL_MAX_ATTEMPTS` else `queued`, `lastError = errorMessage(err)`. Then enqueues the next `mail_backfill` at `now + BACKFILL_GAP_MS` (or the throttle time) while queued rows remain. Logs `mail_backfill: row <id> account <id> <status> found=N stored=N` only.
- CLI `cli/mail-backfill.ts`: `--status` (prints `backfillStatus`), `--retry` (`retryBackfills`).

- [ ] **Step 1: Write the failing tests**

```ts
it('the sweep queues one row per new address per connected mailbox, once; known addresses are not queued again', async () => {
  expect(await queueNewAddressBackfills(prisma)).toBe(4); // 2 addresses × 2 mailboxes
  expect(await queueNewAddressBackfills(prisma)).toBe(0);
});
it("an address change queues rows for the new address only", ...
it('a disconnected mailbox, Sync mail off or an inactive user gets no rows; a new mailbox gets none for known addresses', ...
it('searches 12 months, stores synced-folder mail with its CRM folder (Junk skipped), marks the row done with counts', ...
  expect(row).toMatchObject({ status: 'done', found: 3, stored: 2 });
  expect(stored.map((m) => m.folder).sort()).toEqual(['deleted', 'inbox']);
it('a message already stored is not stored twice', ...
it('a long result stops after 5 pages, keeps the next link and continues on the next job', ...
it('one job at a time: the next is queued 10 s later while rows remain, none when all are done', ...
it('a 429 puts the row back to queued and the next job waits for Retry-After, at least 60 s (Review Focus 3)', ...
  expect(row).toMatchObject({ status: 'queued', attempts: 0 });
  expect(next.runAt.getTime() - Date.now()).toBeGreaterThanOrEqual(119_000); // retry-after=120
it('other failures retry the row 3 times, then failed; a revoked mailbox marks the row skipped', ...
it('rows left running by a lost job go back to queued, and the sweep restarts a lost chain', ...
it('status counts rows by status and mailbox, with no lead addresses; retry re-queues failed and skipped', ...
  expect(JSON.stringify(status)).not.toContain('ana@acme.com');
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailBackfill.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** `backfill.ts`, the handler, the job type, the worker wiring and the CLI.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailBackfill.test.ts test/workerLanes.test.ts test/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Runbook text and commit**

`docs/DEPLOYMENT.md`, **Web mail release 1 — backfill**: starts by itself within a minute of the worker starting (one search per lead/contact address per connected mailbox, one every 10 s, so several hours); watch with `cd ~/live/current/apps/api && node --env-file=$HOME/live/shared/.env dist/cli/mail-backfill.js --status` and `pm2 logs crm-live-worker --lines 50 | grep mail_backfill`; finished when `queued` and `running` are 0; `--retry` re-queues failed/skipped rows (e.g. after a mailbox reconnect); new leads/contacts are fetched the same way within a minute of being added.

```bash
git add apps/api/src/mail/backfill.ts apps/api/src/jobs/handlers/mailBackfill.ts apps/api/src/cli/mail-backfill.ts apps/api/src/jobs/types.ts apps/api/src/worker.ts apps/api/test/mailBackfill.test.ts apps/api/test/workerLanes.test.ts docs/DEPLOYMENT.md
git commit -m "feat(mail): 12-month backfill per lead/contact address for every connected mailbox"
```

---

### Task 8: Team visibility on the mail routes

**Files:**
- Create: `apps/api/src/mail/access.ts`
- Modify: `packages/shared/src/schemas/email.ts` (`MailListQuery.mailOf`)
- Modify: `apps/api/src/routes/mail.ts`
- Modify: `apps/api/src/app.ts` (error handler answers `MailAccessError`)
- Test: `apps/api/test/mailTeam.test.ts` (new), `apps/api/test/mail.test.ts` (the "administrators included" reply/body cases)

**Interfaces:**
- Consumes: Task 1 right and audit action.
- Produces (`mail/access.ts`):
  - `export class MailAccessError extends Error { constructor(readonly code: 'forbidden' | 'view_only', readonly status: 403) }`
  - `export const teamReadableWhere: Prisma.EmailMessageWhereInput` (Global Constraints definition)
  - `export const canSeeTeamMail = (user: AuthUser): boolean` (`can(user.role, 'view_team_mail')`)
  - `export function mailScope(user: AuthUser, mailOf: string | undefined): { where: Prisma.EmailMessageWhereInput; ownerId: number | null }` — `undefined`/`'me'`/own id → `{ userId: user.id }`, ownerId user.id; `'all'` → own OR (others AND teamReadable), ownerId null; another id → that user AND teamReadable, ownerId that id; non-`me` without the right → `MailAccessError('forbidden')`.
  - `export async function messageFor(db: Db, user: AuthUser, rawId: string, use: 'read' | 'crm' | 'change'): Promise<{ m: EmailMessage; viewOnly: boolean }>` — own → viewOnly false; another user's team-readable message with the right → `use === 'change'` throws `MailAccessError('view_only')`, else viewOnly true; anything else `NotFoundError`.
- Produces (`routes/mail.ts`): `MailListQuery.mailOf: 'me' | 'all' | digits` (zod, optional). `GET /mail` and `GET /mail/meta` take `mailOf`; `searchIds(ownerId: number | null, s)` and `awaitingIds(ownerId: number | null)` (null = every mailbox, still ANDed with the scope); `VIEWS` gains `'deleted'`. `listItem` gains `owner: { id: number; name: string }` and `viewOnly: boolean` (list query includes `user: { select: { id: true, name: true } }`). Meta gains `mailUsers: { id: number; name: string }[]` (with the right: active users other than the viewer who have a personal mailbox, by name; otherwise `[]`); its counts and filter lists follow the scope. `GET /mail/:id` uses `messageFor(…, 'read')`; viewOnly → no `fillHtmlBody`, no mark-read, no `mail_action`, thread read from the owner's mailbox with `teamReadableWhere`, `threadHistory(ownerName, open, others)` (first param becomes the owner's name), and `audit(prisma, { entityType: 'email_message', entityId: m.id, action: 'view', userId: user.id, after: { ownerId: m.userId } })` on every open, peek included. `reply`, `read`, `archive`, `link`, `create-lead` use `'change'`; `log`, `task` use `'crm'` (activity `byUserId` and task assignee = the viewer). Route doc comments state the new rule.

- [ ] **Step 1: Write the failing tests** (`mailTeam.test.ts`; rep Maya and Carlos with mailboxes, admin Deepak, manager Neha)

```ts
it('a Sales rep asking for mailOf=all or another user gets 403 forbidden; me and their own id are fine', ...
  expect((await call('GET', '/api/mail?mailOf=all', repCookie)).json()).toEqual({ error: 'forbidden' });
it("Everyone (Administrator and Manager): own mail plus others' lead mail with owner and viewOnly; others' drafts, unlinked and deleted-lead mail stay out", ...
  expect(items.map((i) => [i.subject, i.owner.name, i.viewOnly])).toEqual([...]);
it('Mail of <user>: only that mailbox; search, awaiting, company and lead filters stay inside the scope', ...
it('opening another user\'s message: 200 viewOnly, stays unread, no mail_action, one audit row without content (Review Focus 4)', ...
  for (const q of ['', '?peek=1']) await call('GET', `/api/mail/${m.id}${q}`, adminCookie);
  expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).isRead).toBe(false);
  expect(await prisma.job.count({ where: { type: 'mail_action' } })).toBe(0);
  expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({ entityType: 'email_message', entityId: String(m.id), action: 'view', userId: admin.id, after: { ownerId: rep.id } });
  expect(JSON.stringify(audits)).not.toMatch(/Proposal|acme/);
it('reply, read, archive, link and create-lead on another user\'s message are 403 view_only and change nothing', ...
it("a message that is not team-readable (draft, unlinked, deleted lead) is 404 for an Administrator", ...
it("Log as activity and Add follow-up task work on another user's lead mail, by and for the viewer", ...
it('meta: mailUsers for Administrators and Managers (id, name, active, with a mailbox, not you); [] for a Sales rep', ...
it('?view=deleted lists Deleted items', ...
// mail.test.ts: "nobody can reply to another user's message, administrators included" becomes
// "a Sales rep gets 404 for another user's message; an Administrator gets 403 view_only"
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build -w packages/shared && npm test -w apps/api -- test/mailTeam.test.ts test/mail.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** `access.ts`, the schema field, the route changes and the error handler line.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailTeam.test.ts test/mail.test.ts test/navCounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/access.ts packages/shared/src/schemas/email.ts apps/api/src/routes/mail.ts apps/api/src/app.ts apps/api/test/mailTeam.test.ts apps/api/test/mail.test.ts
git commit -m "feat(mail): Administrators and Managers read every user's lead mail, view only, audited"
```

---

### Task 9: Sales rep's limited view of another owner's lead

**Files:**
- Modify: `apps/api/src/routes/mail.ts` (`GET /mail` shaping, `GET /mail/:id`, `unlinkedWhere`)
- Test: `apps/api/test/mail.test.ts`

**Interfaces:**
- Consumes: Task 8 `listItem`.
- Produces: list item `leadRestricted: boolean` — for a lead the viewer cannot see: `leadId: null`, `leadNumber` kept, `companyId: null`, `leadRestricted: true`. Detail `restrictedLead: { number: string; companyName: string } | null`; when set, `lead`, `contact` and `company` are null. `unlinkedWhere` = `{ leadId: null, folder: { not: 'drafts' } }` (mail on another owner's lead is no longer "unlinked").

- [ ] **Step 1: Write the failing tests** (replace "list hides the number of a lead the user can no longer see")

```ts
it("list shows a lead the rep cannot open by number only", async () => {
  expect(item).toMatchObject({ leadId: null, leadNumber: lead.number, companyId: null, leadRestricted: true });
});
it("opening it gives the lead number and company name only", ...
  expect(body).toMatchObject({ restrictedLead: { number: lead.number, companyName: 'Acme' }, lead: null, contact: null, company: null });
it("mail on another owner's lead is not counted or listed as Unlinked", ...
it('Log as activity on it is 409 no_lead', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mail.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mail.test.ts test/mailTeam.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/mail.ts apps/api/test/mail.test.ts
git commit -m "feat(mail): a rep's mail on another owner's lead shows the lead number and company only"
```

---

### Task 10: Lead Emails tab and timeline follow the rule; privacy wording

**Files:**
- Modify: `apps/api/src/routes/leadEmails.ts` (`emailView`, `GET /leads/:id/emails`)
- Modify: `apps/api/src/leads/serialize.ts` (`activityRow`)
- Modify: `apps/api/src/routes/leads.ts:359,388` (callers)
- Modify: `README.md:35`, `docs/data-model.md:304,406`, `docs/PENDING.md:90`, `docs/DAIT-CRM-Specification-v2.md:267,471`, `docs/RELEASE-PARITY-CHECKLIST.md:133` (privacy wording)
- Test: `apps/api/test/leadEmails.test.ts`, `apps/api/test/leads.test.ts` (timeline wording if asserted)

**Interfaces:**
- Consumes: Task 8 `canSeeTeamMail`, `teamReadableWhere`.
- Produces: `emailView(m: EmailMessage & { user?: { name: string } }, viewerId?: number)` adds `ownerName: string | null` (null for the viewer's own mail and on POST answers). `GET /leads/:id/emails`: with the right, `{ leadId: id, folder: { not: 'drafts' }, OR: [{ userId: user.id }, { AND: [{ userId: { not: user.id } }, teamReadableWhere] }] }`, else own as today; when it returns others' mail, one audit row `{ entityType: 'lead', entityId: id, action: 'view', userId, after: { emailMessageIds: [...] } }`. `activityRow(a: ActivityRow, viewer?: { id: number; teamMail: boolean })`: an email line is hidden unless `viewer.teamMail` or `a.byUserId === viewer.id`.
- Privacy wording (replaces "private to its owner, administrators included" for mail; the calendar stays private): "Lead mail belongs to the mailbox owner. Administrators and Managers can read every user's lead mail (view only, each opening audited); Sales representatives and Data research users see only their own. Personal and other mail is not stored."

- [ ] **Step 1: Write the failing tests** (replace "privacy: only the sender lists the message; others see "Email sent" without the subject")

```ts
it('Emails tab: an Administrator or Manager lists every user\'s mail on the lead with ownerName; a Sales rep only their own', ...
  expect(adminItems.map((e) => [e.subject, e.ownerName])).toEqual([['Proposal', 'Maya Pillai'], ...]);
  expect(otherRepItems).toEqual([]);
it('timeline: Administrators and Managers see the email subject; a Sales rep sees "Email sent" only', ...
it("listing others' mail on the lead writes one audit row with message ids and no content", ...
it('mail of a deleted lead never reaches the lead tab (it has no lead)', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/leadEmails.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block and update the privacy wording in the listed docs and route comments.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/leadEmails.test.ts test/leads.test.ts test/leadService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/leadEmails.ts apps/api/src/leads/serialize.ts apps/api/src/routes/leads.ts apps/api/test/leadEmails.test.ts README.md docs
git commit -m "feat(leads): Emails tab and timeline show the team's lead mail to Administrators and Managers"
```

---

### Task 11: Email screen — Mail of picker, view only, restricted chip, Deleted items

**Files:**
- Modify: `apps/web/src/api/mail.ts`, `apps/web/src/api/leadEmails.ts`
- Modify: `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/pages/email/Reader.tsx`
- Modify: `apps/web/src/pages/leads/FollowUpPanel.tsx` (`EmailList`)
- Modify: `apps/web/src/i18n/labels.ts` (`errorText`: `view_only`), `apps/web/src/styles/app.css` (`.viewonly`, `.vo-pill`, `.mail-of`, `.mail-why`)
- Modify: `apps/web/src/locales/en.json`, `es.json`, `fr.json`
- Test: `apps/web/test/emailPage.test.tsx`, `apps/web/test/followUpPanel.test.tsx`, `apps/web/e2e/email.spec.ts`

**Interfaces:**
- Consumes: Task 8/9/10 response fields (`owner`, `viewOnly`, `leadRestricted`, `restrictedLead`, `mailUsers`, `ownerName`), right `view_team_mail`, view `deleted`.
- Produces: `MAIL_VIEWS` gains `'deleted'` (after `'archive'`, label `Deleted items`); `MailFilter.mailOf?: 'all' | number` (sent as `mailOf`, only when set); `useMailMeta(mailOf?: 'all' | number)` (query key includes it); types `MailItem.owner`, `MailItem.viewOnly`, `MailItem.leadRestricted`, `MailDetail.restrictedLead`, `MailMeta.mailUsers`, `LeadEmail.ownerName`. Address param `mailof` (`all` or a user id; absent = Me); ignored for users without `view_team_mail`.
- Screen (minimal, mockup state 5 wording): with `view_team_mail`, a labelled select `Mail of:` at the top of the folder column (options `Me`, `Everyone`, then each `mailUsers` name; `title` = `Administrators and managers. Team mail is view only.`). In team view the top bar line reads `Team view · lead mail of {who}` + badge `View only` + `for other mailboxes`, and each row shows its mailbox owner's name. A `viewOnly` message: banner `View only — {first}'s mailbox.` + `You can read, log and create tasks; only {first} can reply from this mailbox.`; Reply, Archive and Link/Create lead disabled with `title` = `View only — {first}'s mailbox`; the footer shows the pill with the same words; Log as activity and Add follow-up task stay. `leadRestricted` row chip `{lead} · another owner's lead`; reader side panel for `restrictedLead`: a non-link Lead card (`{lead} · another owner's lead`) and a non-link Company card with the name; no Link to lead button. Folder footer note `Only mail with your leads and contacts is shown here · Why?` with a toggled popover (`What the CRM keeps` + the three bullets + the closing line). Lead Emails tab: `{name}'s mailbox` after the date for others' mail.

- [ ] **Step 1: Write the failing tests**

```tsx
it('Mail of picker (Administrator / Manager): Me, Everyone and each user; Everyone asks for mailOf=all and shows each row\'s mailbox', async () => {
  // me with view_team_mail; META.mailUsers [{ id: 9, name: 'Carlos Torres' }]
  expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Me', 'Everyone', 'Carlos Torres']);
  await user.selectOptions(picker, 'Everyone');
  expect(lastListUrl()).toContain('mailOf=all');
  expect(screen.getByText('Team view · lead mail of everyone')).toBeInTheDocument();
  expect(row).toHaveTextContent('Carlos Torres');
});
it('no Mail of picker for a Sales rep, and no mailOf in its requests', ...
it("another user's message is view only: banner, pill, Reply / Archive / Link disabled with the title; Log and task enabled", ...
  expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reply' })).toHaveAttribute('title', "View only — Carlos's mailbox");
  expect(screen.getByRole('button', { name: 'Log as activity' })).toBeEnabled();
it("a message on another owner's lead: chip 'LD-1005 · another owner's lead', side panel company name only, no lead link", ...
  expect(within(side).queryByRole('link', { name: /Lead/ })).toBeNull();
it('Deleted items folder; footer note with a Why? popover', ...
it('team view wording in Spanish', ... // es: picker label, banner
// followUpPanel.test.tsx
it("Emails tab marks another user's mail with their mailbox", ... expect(item).toHaveTextContent("Carlos Torres's mailbox");
```

Update `META` and `item()` fixtures with the new fields; adjust the folder-list test for `Deleted items`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailPage.test.tsx test/followUpPanel.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** the types, picker, view-only states, chip, folder, note and translations (es/fr for every phrase in Global Constraints).

- [ ] **Step 4: Run unit tests, types and i18n**

Run: `npm run test:unit -w apps/web && npm run typecheck && npm run i18n:check`
Expected: PASS, no missing es/fr phrases.

- [ ] **Step 5: Update the e2e spec and run it**

In `email.spec.ts`: Maya (Administrator) still sees "Nothing here." with Mail of: Me; with `Mail of:` → `Neha Kapoor` she sees `Re: Orbit proposal` but not `Website enquiry`, the open message shows `View only — Neha's mailbox.` and a disabled Reply; on the Orbit lead timeline she now sees `Re: Orbit proposal` (the old `not.toContainText` becomes `toContainText`).
Run: `npm run build && npm test -w apps/web -- e2e/email.spec.ts`
Expected: PASS.

- [ ] **Step 6: Parity screenshots**

With the e2e server, capture the team view (Mail of: Everyone, a view-only message open) at 1440 and 1280 in en/es/fr next to mockup state 5 into `~/Documents/DAIT-CRM/parity-screenshots-web-mail/release-1/`; the picker label, menu entries and view-only wording must read as the mockup (layout stays the current screen until release 2).

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): Mail of picker, view-only team mail, another owner's lead chip, Deleted items"
```

---

### Task 12: Release notes and full suite

**Files:**
- Modify: `docs/PENDING.md` ("Ready, waiting for deploy": web-mail release 1, with the two one-time steps; owner-facing note that non-lead mail leaves the CRM, stays in Outlook)

- [ ] **Step 1: Update `docs/PENDING.md`** — what release 1 changes, that the deploy needs the clean-up step and watching the backfill (`docs/DEPLOYMENT.md`), and the calls flagged to the owner (drafts left out of team view; project-tagged mail kept by the clean-up; Unlinked and My leads unchanged until release 2).

- [ ] **Step 2: Run the whole suite**

Run: `npm run typecheck && npm test && npm run build && npm test -w apps/web`
Expected: all green (api, shared, web unit, deploy test, e2e).

- [ ] **Step 3: Commit**

```bash
git add docs/PENDING.md
git commit -m "docs: web-mail release 1 pending notes and deploy steps"
```

---

## Self-review

- **Spec coverage:** lead-mail rule + shared free-mail list → T2; conversation rule → T2/T4/T5; Deleted Items + 12-month initial → T4; linking ignores visibility, prefer open then most recent → T3; rep limited chip → T9 (server) + T11 (web); clean-up with deleted-lead exemption and per-user counts → T1 (marker) + T5; release backfill, per-address on create/change, rate limited, resumable, observable → T6 + T7; team visibility on every mail route, view only, no mark-read → T8; lead Emails tab + timeline → T10; audit without content → T8/T10; Mail of picker + view-only wording, en/es/fr → T11; docs (PENDING, MIGRATIONS, DEPLOYMENT, privacy) → T1/T5/T7/T10/T12.
- **Types:** `LeadMailRules`, `participantsOf`, `isLeadMail`, `inLeadConversation` (T2) used by T4/T5/T7; `storeMessage(..., rules)` / `StoreResult` / `FOLDERS` (T4) used by T7; `searchStartUrl` / `searchPage` / `folderIds` (T6) used by T7; `mailScope` / `messageFor` / `teamReadableWhere` / `canSeeTeamMail` (T8) used by T9/T10; response fields named identically in T8–T11.
- **Review Focus:** each of the five lines has its test in T2, T2/T3, T7, T8, T5.
