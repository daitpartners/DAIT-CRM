# Release 2B-2 — mail sync and the Email screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync each user's Microsoft 365 mail into the CRM, link it to leads, and give them the prototype's Email screen.

**Architecture:** Worker job `sync_mailbox` pulls Graph delta pages per folder into `email_messages`; `mail/match.ts`
links them; `routes/mail.ts` serves the screen with every query filtered to the caller; Graph writes (read, archive,
reply) run as jobs. The web gets `pages/email/*`.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, MSAL + Graph REST, React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-release-2b2-sync-email-screen-design.md`

## Global Constraints

- Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`); tests `TZ=Europe/London npm test`; e2e needs `npm run build`.
- Every mail query has `userId: request.user.id`; no right (not even `view_admin_settings`) widens it. Another user's message id → 404.
- Lead links only to leads the user can see (`leadWhere`, `assertLeadVisible`).
- Every visible phrase through `t()` with es/fr entries; `npm run i18n:check` clean.
- Migration drift check empty; no token, body or address in logs or audit rows (audit `{emailMessageId}` only).
- Caps: 90 days initial, 50 per page, 20 pages per folder per run, body 50,000 chars, list 200, preview 120, sync every 5 min, more-pages rerun 1 min, CRM-sent claim window 15 min.

## Review Focus

1. A user (any role) requesting `/mail/:id` or any `/mail/:id/*` of another user's message → 404, nothing changed.
2. A mailbox taken over by another user, or reconnected with another address → old mail stays with the old user; sync starts fresh.
3. A message moved between Inbox and Archive in Outlook during one run → one row, new folder, links kept.
4. The CRM-sent message showing up in Sent Items → no duplicate row; a reply's "RE:" subject still claims it.
5. A delta link expired (410) or a token revoked mid-sync → folder restarts / mailbox `error`, no crash loop.

---

### Task 1: Data — migration, reconnect reset

**Files:** `prisma/schema.prisma`, `prisma/migrations/20261128100000_mail_sync/migration.sql`, `apps/api/src/graph/accounts.ts`, test `apps/api/test/personalMailbox.test.ts`.

**Produces:** `EmailMessage.{graphId, source, fromName, attachmentNames, replyToId, loggedAt}`, `@@unique([userId, graphId])`, `@@index([userId, threadId])`; `EmailAccount.syncState Json @default("{}")`.

- [ ] Test `reconnect by another user clears sync state` and `reconnect with another address starts with empty sync state` (connectPersonalMailbox on a row with `syncState {inbox:{link:'x'}}` → `{}`); same user + same address keeps it.
- [ ] Run → FAIL (no column). Add schema + migration; in `connectPersonalMailbox` set `syncState: {}` when the existing row's userId differs. Run → PASS; drift check empty. Commit.

### Task 2: Graph client — mail reads and writes

**Files:** `apps/api/src/graph/client.ts`, test `apps/api/test/graphClient.test.ts`.

**Produces:**
```ts
export type MailFolder = 'inbox' | 'sentitems' | 'drafts' | 'archive';
export interface GraphMessage { id: string; subject: string; from: { name: string; address: string } | null; to: string[]; cc: string[]; receivedAt: string; sentAt: string | null; isRead: boolean; isDraft: boolean; conversationId: string | null; internetMessageId: string | null; hasAttachments: boolean; bodyText: string }
export interface DeltaPage { messages: GraphMessage[]; removed: string[]; nextLink?: string; deltaLink?: string }
export function deltaStartUrl(folder: MailFolder, since: Date): string
GraphClient += deltaPage(account, url): Promise<DeltaPage>; attachmentNames(account, graphId): Promise<string[]>;
  markRead(account, graphId, isRead): Promise<void>; moveTo(account, graphId, folder: 'archive' | 'inbox'): Promise<void>;
  reply(account, graphId, msg: { to: string[]; cc?: string[]; html: string }): Promise<void>
export const GRAPH_MAIL_SCOPES = ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'offline_access']
```
All mail calls go to `https://graph.microsoft.com/v1.0/me/...` with `Prefer: IdType="ImmutableId"` (delta also `odata.maxpagesize=50, outlook.body-content-type="text"`); token acquisition shared with `sendMail` (one helper). Errors → `GraphError(message, status)` as sendMail does.

- [ ] Tests (fetch stubbed): `deltaStartUrl` contains `/me/mailFolders/inbox/messages/delta`, `$filter=receivedDateTime ge <iso>` and the `$select`; `deltaPage` maps a page (from/to/cc/body, `@removed` → `removed`, next/delta links) and sends the Prefer headers; `deltaPage` 410 → `GraphError` status 410; `markRead` PATCHes `{isRead}`; `moveTo` POSTs `{destinationId:'archive'}`; `reply` POSTs `{comment, message:{toRecipients, ccRecipients}}`; `attachmentNames` returns names.
- [ ] FAIL → implement → PASS. Commit.

### Task 3: Matching

**Files:** `apps/api/src/mail/match.ts`, test `apps/api/test/mailMatch.test.ts`.

**Produces:** `matchMail(db, user: AuthUser, m: { threadId: string | null; counterparts: string[]; ownAddress: string }): Promise<{ leadId: number | null; contactId: number | null; companyId: number | null }>` and `mailUser(db, userId): Promise<AuthUser | null>` (moved from `canUserSeeLead`'s builder).

- [ ] Tests: thread hit inherits links; contact email (case-insensitive) → contact/company/open lead, own lead preferred over a teammate's, closed leads skipped, falls back to company's open lead; domain → company + its single open lead (two open → no lead); gmail and own domain → unlinked; a lead the rep cannot see is not linked (company/contact still are).
- [ ] FAIL → implement → PASS. Commit.

### Task 4: Sync job, scheduling, Sync now

**Files:** `apps/api/src/jobs/handlers/syncMailbox.ts`, `apps/api/src/mail/schedule.ts`, `apps/api/src/jobs/types.ts`, `apps/api/src/worker.ts`, `apps/api/src/routes/mailboxes.ts`, tests `apps/api/test/syncMailbox.test.ts`, `apps/api/test/mailboxes.test.ts`.

**Consumes:** Task 2 `GraphClient.deltaPage/attachmentNames`, Task 3 `matchMail`. **Produces:** job types `sync_mailbox {accountId}`; `scheduleMailSync(db, now?): Promise<number>`; `requestSync(db, accountId)`.

- [ ] Tests with a fake Graph: first run stores rows (received/sent/draft, folder, from name, attachments, links) and the delta link per folder; second run starts from the stored link; CRM-sent row claimed (no duplicate) incl. "RE:" subject; existing row keeps hand links, updates isRead/folder; removed-then-added across folders in one run → one row in the new folder; removed synced row deleted, CRM row kept (graphId cleared); 20-page cap → next link stored and a job queued in ~1 min; 410 → folder restarts; auth failure → account `error`; disconnected / syncMail off → nothing fetched; another user's same graph id → separate row. Scheduler: one job per eligible account, none duplicated, runAt = lastSyncAt + 5 min. Route: `POST /mailboxes/:id/sync` owner → 202 and a due job; someone else's → 404.
- [ ] FAIL → implement → PASS. Commit.

### Task 5: Outgoing mail — compose, reply, Graph actions

**Files:** `apps/api/src/mail/outgoing.ts` (from `routes/leadEmails.ts`), `apps/api/src/routes/mail.ts` (POST /mail, reply), `apps/api/src/jobs/handlers/sendUserEmail.ts`, `apps/api/src/jobs/handlers/mailAction.ts`, `packages/shared/src/schemas/email.ts`, tests `apps/api/test/mail.test.ts`, `apps/api/test/leadEmails.test.ts`.

**Produces:** `queueOutgoing(tx, user, account, { lead: Lead | null; companyId?: number | null; contactId?: number | null; to: string[]; cc: string[]; subject: string; body: string; replyToId?: number; followUpDays?: number | null }): Promise<EmailMessage>`; shared `MailCompose {to, cc, subject, body, leadId?, companyId?}`, `MailReply {cc, body}`; job `mail_action {emailMessageId, action: 'read' | 'unread' | 'archive'}`.

- [ ] Tests: 2B-1 lead send unchanged (existing tests stay green); POST /mail without lead → unlinked queued message, auto-matched; with lead → history line + Contacted; reply to own received message → queued with replyToId, subject "Re: …", to = sender, same links; reply to another user's message → 404; send handler with replyToId calls `graph.reply` with the original graph id (falls back to sendMail when it has none); mail_action read/archive calls Graph and is a no-op for a message without graph id.
- [ ] FAIL → implement → PASS. Commit.

### Task 6: Reading routes, logging, linking, nav, lead tab

**Files:** `apps/api/src/routes/mail.ts`, `apps/api/src/routes/navCounts.ts`, `apps/api/src/leads/serialize.ts`, `apps/api/src/routes/leadEmails.ts`, tests `apps/api/test/mail.test.ts`, `navCounts.test.ts`, `leads.test.ts`.

- [ ] Tests: GET /mail views (inbox/sent/drafts/archive/unlinked/awaiting/mine), company/lead filters, search; never another user's (Administrator included); GET /mail/meta counts and filter lists; GET /mail/:id detail + thread + marks read (+ mail_action job); read/archive; log once (409 `already_logged`, 409 `no_lead`), masked "Email received" for others; link to visible lead (invisible → 404); create-lead (domain-matched company linked; new company named from sender; message linked; lead allocated); task due tomorrow; nav `mailUnread`; lead Emails tab includes received, excludes drafts.
- [ ] FAIL → implement → PASS. Commit.

### Task 7: Web — Email screen, compose, sidebar, Sync now, Emails tab

**Files:** `apps/web/src/api/mail.ts`, `apps/web/src/pages/email/{EmailPage,MessageList,Reader,MailSide,ComposeModal,LinkLeadModal}.tsx`, `router.tsx`, `components/Sidebar.tsx`, `pages/settings/Connections.tsx`, `pages/leads/FollowUpPanel.tsx`, `styles/*.css` (prototype `.mail/.folders/.fold/.msglist/.msg/.reader/.mailside`), `locales/{es,fr}.json`, unit tests beside existing web tests.

- [ ] Unit tests (RTL, fake fetch): folders + counts render; unlinked badge "Unlinked · create lead?"; reader buttons per state (drafts none; unlinked → Link to lead / create lead; Log disabled without lead); compose fills To from lead contact and template; not connected header. FAIL → implement → PASS; `npm run i18n:check`. Commit.

### Task 8: e2e, seed, docs

**Files:** `apps/api/test/e2e-seed.ts` (mail for Maya and Neha), `apps/web/e2e/email.spec.ts`, `README.md`, `docs/RELEASE-PARITY-CHECKLIST.md`.

- [ ] e2e: Maya sees her inbox, opens an unread one (count drops), logs it on the lead, adds a task, links an unlinked one; Neha (Manager) does not see Maya's mail and sees "Email received" on the lead; search and folder switch. Full build + full suite green. Commit.
