# Web mail release 2 (screen and two-way actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Email screen is laid out and behaves like Microsoft 365 web mail (mockup states 1, 4, 5): top bar with search and filters, command bar, folder pane, conversation list, conversation reading pane with attachments, lead panel, keyboard shortcuts. Delete, Archive, Move, Flag and Read/Unread change the owner's Outlook mailbox through Graph, and Reply all / Forward go out through the existing send path.

**Architecture:** On the API, one module (`mail/changes.ts`) applies every mailbox change: it calls Graph first, inline, and only then writes the CRM row. A Graph refusal therefore leaves the CRM unchanged and answers an error code that the screen turns into a rollback and a toast. A second module (`mail/list.ts`) builds the list query: views, chips, filters, sort and conversation grouping, with a pure `orderCandidates`. The reading endpoint returns the conversation, a lead panel and on-demand attachment links that are proxied from Graph. The web screen is split into focused components under `pages/email/`. One `useMailCommands` hook decides, for the command bar, the row hover actions, the right-click menu and the shortcuts, what is enabled and what each command does, so the view-only rule lives in a single place.

**Tech Stack:** Fastify 5, Prisma 6 / Postgres, Microsoft Graph v1.0 (delegated Mail.ReadWrite + Mail.Send, already consented), vitest, React 18 + Vite + TanStack Query 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-web-mail-email-design.md` (release 2 = "Screen", "Two-way with Outlook" and the reading parts). The mockup is the spec for the screen: `docs/superpowers/mockups/2026-11-26-outlook-mail.html` (states 1, 4, 5: HTML lines 762–1006, CSS lines 317–760, behaviour in the `<script>` from line 1122) and `~/Documents/DAIT-CRM/mockup-screens-outlook-mail/` (`1-inbox-reading-*.png`, `4-right-click-menu-1440.png`, `5-admin-team-view-1440.png`, `5b-mail-of-menu-1440.png`). Builds on release 1 (`docs/superpowers/plans/2026-11-26-web-mail-release-1.md`, branch head 2f981c2).

## Global Constraints

- Release 2 only. Not in this release (release 3): inline reply editor, full-page New message, signature, Schedule send (the Scheduled folder only lists), Undo send, the follow-up box after Send, task `priority`/`note`. Reply, Reply all, Forward and New mail open the existing `ComposeModal`.
- No Unlinked folder or smart view (spec non-goal). No Junk, rules, the user's own folders, Focused/Other, categories, Pin, Snooze, reactions.
- Mailbox changes happen through Graph on the **owner's** mailbox only. In team view (another user's message), Delete, Archive, Move, Reply, Reply all, Forward, Flag, Mark read/unread, Link/Unlink and Create lead are `403 { error: 'view_only' }` on the server and disabled on the screen with the title `View only — {name}'s mailbox` (first name). Log as activity, Create task, Follow-up, Schedule meeting and Open lead stay allowed. Opening another user's message never marks it read.
- Folder mapping CRM ↔ Graph: `inbox` ↔ `inbox`, `archive` ↔ `archive`, `deleted` ↔ `deleteditems`, `sent` ↔ `sentitems`, `drafts` ↔ `drafts`. Move to offers exactly Inbox, Archive, Deleted items.
- Flag presets (user's time zone): Today = today; Tomorrow = today + 1; This week = this week's Friday (today when today is Friday, Saturday or Sunday); Next week = next Monday; No date = flagged without dates; Mark complete; Clear flag.
- Follow-up ▾ presets (user's time zone, 24-hour): Later today 17:00 (offered only before 17:00), Tomorrow 09:00, Next week = next Monday 09:00, In 2 weeks = today + 14 days 09:00, Choose date and time…, Clear follow-up. It sets the lead's `nextFollowUp` (a date) and the open follow-up task's `dueTime` (spec "Settled" 5).
- Keyboard: `Delete` delete, `E` archive, `Ctrl+U` (`⌘U` on macOS) mark unread, `R` reply, `Shift+R` reply all, `F` forward, `N` new mail, `Esc` closes the open menu/panel. None of them fires while focus is in an input, textarea, select or contenteditable element, or while a dialog is open.
- Conversation view is on by default. A conversation is one owner's messages with the same `threadId` (a message without one is its own conversation), so team view shows one row per mailbox. The reading pane shows the conversation newest on top: the opened message is expanded and the others are collapsed rows.
- Lead panel starts folded when the window is narrower than 1400 px. The folder pane stays collapsible and remembered (`dait-mail-folders-collapsed`).
- Attachments are fetched from Graph on demand through the server and never stored. Preview (inline in a new tab) only for bytes that `sniff()` (mail/files.ts) recognises as PDF, PNG, JPEG or GIF. Everything else is a download (`application/octet-stream`, `Content-Disposition: attachment`). Every response sends `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`. Larger than `ATTACHMENT_PROXY_MAX_BYTES = 25_000_000` → `413 { error: 'attachment_too_large' }`.
- HTML bodies keep the existing sanitiser and CSP. On the Email screen only, the frame gains `allow-same-origin` (never `allow-scripts`) so that its height can follow the content. The Mailer and lead-page frames are unchanged.
- Error codes for mailbox changes: `mailbox_not_connected` 409, `outlook_refused` 502 (Graph 400/403/404), `outlook_busy` 503 (Graph 429, 5xx, timeout), `sending` 409 (a CRM message still queued/sending), `draft` 409 (move/archive of a draft), `view_only` 403. Logs and audit rows carry ids, counts and Graph status only, never subject, body or addresses.
- Live CRM theme only: the tokens in `apps/web/src/styles/app.css`, Montserrat, the existing `.btn`, `.badge`, `.in` and `.chip` components. No dark mode (the live CRM has none). New CSS lives under the `.wm` root class. Icons are copied from the mockup's `P` icon map into `apps/web/src/components/Icons.tsx`.
- en/es/fr for every UI string (`npm run i18n:check`). Dates and times are 24-hour in the viewer's time zone.
- No new npm dependency. No new Microsoft permission (only Mail.ReadWrite and Mail.Send are used).
- Every command runs from `~/Documents/DAIT-CRM/CRM-DAIT` with `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London`. Unit DB `dait_crm_unit` (vitest default), e2e DB `dait_crm_e2e` (`apps/web/e2e/start-server.sh`). After changing `packages/shared`, run `npm run build -w packages/shared` before the api/web tests.
- Commits go on branch `web-mail-r2` and end with the two trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GKS9Jmtrg6EmfFh6J9p9ci`. Deploy only on the owner's "deploy", database backup first.

## Review Focus

1. Outlook refuses or throttles a change (the message was already moved or deleted in Outlook → 404; Graph 429). The CRM row must be left exactly as it was, the row on screen must go back to where it was, and a toast must say why. Test in Task 5.
2. A received attachment named `invoice.pdf` whose bytes are HTML (or whose claimed type is `text/html`) must never be served inline. It is always a download with `nosniff`, so it cannot run in the CRM's origin. Test in Task 9.
3. In conversation view, the same conversation in two mailboxes (team view) stays two rows, a message without a `threadId` is its own row, and `total` counts rows, not messages, so infinite scroll stops at the right place. Test in Task 7.
4. Typing `e`, `r`, `n` or pressing Delete in the search box, a filter field, the Link to lead search or the Compose dialog must type the character and must not archive, reply, open New mail or delete. Test in Task 14.
5. The presets around day boundaries: an Asia/Kolkata user at 23:30 UTC (already "tomorrow" for them), a Friday or Sunday "This week", and "Later today" at 17:00 or later. The dates must be the user's local days, not UTC days. Test in Task 2.

---

### Task 1: Schema for flags and size

**Files:**
- Modify: `prisma/schema.prisma` (`EmailMessage`)
- Create: `prisma/migrations/20261213100000_web_mail_screen/migration.sql` (generated, then the back-fill line added)
- Modify: `docs/MIGRATIONS.md`, `docs/data-model.md`
- Test: `apps/api/test/db.test.ts`

**Interfaces:**
- Produces: `EmailMessage.flagStatus: string` (`flag_status VARCHAR(12) NOT NULL DEFAULT 'notFlagged'`; values `notFlagged | flagged | complete`), `EmailMessage.flagDue: Date | null` (`flag_due DATE`), `EmailMessage.sizeBytes: number` (`size_bytes INTEGER NOT NULL DEFAULT 0`); index `@@index([userId, flagStatus])`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/db.test.ts
it('email_messages has flag_status (default notFlagged), flag_due and size_bytes (default 0)', async () => {
  const m = await prisma.emailMessage.create({ data: { userId: user.id, folder: 'inbox', status: 'received', fromAddress: 'a@b.co', subject: 's' } });
  expect(m).toMatchObject({ flagStatus: 'notFlagged', flagDue: null, sizeBytes: 0 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/api -- test/db.test.ts`
Expected: FAIL (unknown field `flagStatus`).

- [ ] **Step 3: Change the schema and generate the migration**

Add the three fields and the index, and update the model comment ("flags and size: web-mail release 2"). Run `npm run db:migrate -w apps/api -- --name web_mail_screen`, then rename the folder to `20261213100000_web_mail_screen`. Append the back-fill `UPDATE "email_messages" SET "size_bytes" = octet_length(coalesce("body_html", "body_text"));` and check that the SQL only adds.

- [ ] **Step 4: Run the test**

Run: `npm test -w apps/api -- test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Document and commit**

`docs/MIGRATIONS.md` row 27: `20261213100000_web_mail_screen` | `email_messages.flag_status` (default `notFlagged`), `flag_due`, `size_bytes` (back-filled from the stored body length); index (`user_id`, `flag_status`) | Web mail release 2 (not yet released). Add the columns to `docs/data-model.md`.

```bash
git add prisma docs/MIGRATIONS.md docs/data-model.md apps/api/test/db.test.ts
git commit -m "feat(mail): flag and size columns for the web-mail screen"
```

---

### Task 2: Shared schemas and date presets

**Files:**
- Create: `packages/shared/src/mailDates.ts`
- Modify: `packages/shared/src/index.ts` (export it), `packages/shared/src/schemas/email.ts`
- Test: `packages/shared/test/mailDates.test.ts`, `packages/shared/test/mailSchemas.test.ts`

**Interfaces:**
- Produces (`mailDates.ts`; all days are `YYYY-MM-DD` strings in the user's zone, the caller passes today):
  - `export const FLAG_PRESETS = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'noDate'] as const; export type FlagPreset = (typeof FLAG_PRESETS)[number];`
  - `export function addDays(day: string, n: number): string`
  - `export function flagDueDay(preset: FlagPreset, today: string): string | null` (`noDate` → null)
  - `export type FollowUpKey = 'laterToday' | 'tomorrow' | 'nextWeek' | 'twoWeeks'`
  - `export function followUpChoices(today: string, nowTime: string): { key: FollowUpKey; date: string; time: string }[]` (`nowTime` = `HH:MM` in the user's zone)
  - `export function localNow(timezone: string, now?: Date): { day: string; time: string }`
- Produces (`schemas/email.ts`):
  - `export const MOVE_FOLDERS = ['inbox', 'archive', 'deleted'] as const`
  - `export const MailChange = z.discriminatedUnion('type', [z.object({ type: z.literal('move'), folder: z.enum(MOVE_FOLDERS) }), z.object({ type: z.literal('delete') }), z.object({ type: z.literal('read'), isRead: z.boolean() }), z.object({ type: z.literal('flag'), flag: z.enum([...FLAG_PRESETS, 'complete', 'clear']) })]); export type MailChange`
  - `export const BULK_MAX = 50; export const MailBulk = z.object({ ids: z.array(z.number().int().positive()).min(1).max(BULK_MAX), change: MailChange })`
  - `MailReply` becomes `z.object({ mode: z.enum(['reply', 'replyAll', 'forward']).default('reply'), to: z.array(mailAddress).max(20).default([]), cc: mailCc, body: mailBody, bodyHtml })`, refined so that `forward` needs at least one `to` (issue path `['to']`). `to` is ignored for `reply`/`replyAll`.
  - `export const MailFollowUp = z.union([z.object({ date: ymdString, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }), z.object({ clear: z.literal(true) })])` (`ymdString` is the existing date-string schema of `LeadUpdate.nextFollowUp`).
  - `MailListQuery` gains: `chip: z.enum(['all', 'unread', 'flagged', 'attachments']).optional()`, `conv: z.enum(['0', '1']).optional()`, `sort: z.enum(['date', 'from', 'lead', 'stage', 'size']).optional()`, `dir: z.enum(['desc', 'asc']).optional()`, `from`, `to`, `subject`, `leadQ` (`z.string().max(200).optional()`), `owner: z.union([z.literal('me'), z.string().regex(/^\d{1,9}$/)]).optional()`, `date: z.enum(['today', '7d', '30d', '12m', 'custom']).optional()`, `since`, `until` (`ymdString.optional()`), `attachments: z.literal('1').optional()`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/mailDates.test.ts
test('flag presets from Thursday 26 Nov 2026 (mockup)', () => {
  expect(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'noDate'].map((p) => flagDueDay(p as FlagPreset, '2026-11-26')))
    .toEqual(['2026-11-26', '2026-11-27', '2026-11-27', '2026-11-30', null]);
});
test('This week on Friday, Saturday and Sunday is that day; Next week is the following Monday (Review Focus 5)', () => {
  expect(flagDueDay('thisWeek', '2026-11-27')).toBe('2026-11-27');
  expect(flagDueDay('thisWeek', '2026-11-29')).toBe('2026-11-29');
  expect(flagDueDay('nextWeek', '2026-11-29')).toBe('2026-11-30');
});
test('follow-up choices at 14:30 on Thu 26 Nov (mockup), and no Later today from 17:00 (Review Focus 5)', () => {
  expect(followUpChoices('2026-11-26', '14:30')).toEqual([
    { key: 'laterToday', date: '2026-11-26', time: '17:00' }, { key: 'tomorrow', date: '2026-11-27', time: '09:00' },
    { key: 'nextWeek', date: '2026-11-30', time: '09:00' }, { key: 'twoWeeks', date: '2026-12-10', time: '09:00' },
  ]);
  expect(followUpChoices('2026-11-26', '17:00').map((c) => c.key)).toEqual(['tomorrow', 'nextWeek', 'twoWeeks']);
});
test('localNow uses the user zone: 23:30 UTC is already the next day in Asia/Kolkata (Review Focus 5)', () => {
  expect(localNow('Asia/Kolkata', new Date('2026-11-26T23:30:00Z'))).toEqual({ day: '2026-11-27', time: '05:00' });
});
// packages/shared/test/mailSchemas.test.ts
test('MailChange accepts the four kinds and refuses an unknown folder', () => {
  expect(MailChange.parse({ type: 'move', folder: 'deleted' })).toEqual({ type: 'move', folder: 'deleted' });
  expect(MailChange.safeParse({ type: 'move', folder: 'junk' }).success).toBe(false);
});
test('MailBulk takes 1 to 50 ids', () => { /* 0 ids and 51 ids fail; 50 pass */ });
test('MailReply: forward needs a To; reply defaults its mode', () => {
  expect(MailReply.safeParse({ mode: 'forward', body: 'x' }).success).toBe(false);
  expect(MailReply.parse({ body: 'x' }).mode).toBe('reply');
});
test('MailFollowUp: date + 24-hour time, or clear', () => { /* '24:00' fails; { clear: true } passes */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w packages/shared -- test/mailDates.test.ts test/mailSchemas.test.ts`
Expected: FAIL (module / exports not found).

- [ ] **Step 3: Implement** the module and the schema changes with the signatures above. For `localNow`, use `Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23' })` parts, as `todayIn` in `apps/api/src/leads/dates.ts` does.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run build -w packages/shared && npm test -w packages/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): mailbox change, bulk, reply-mode, follow-up and list-filter schemas; flag and follow-up presets"
```

---

### Task 3: Graph client — flags, moves, delete, attachments, reply all, forward; test fakes

**Files:**
- Modify: `apps/api/src/graph/client.ts`
- Create: `apps/api/src/graph/e2eFake.ts`
- Modify: `apps/api/src/app.ts:133` (graph choice), `apps/web/e2e/start-server.sh` (`export E2E_FAKE_GRAPH=1`)
- Modify: `apps/api/test/helpers.ts` (`fakeGraph`), `apps/api/test/e2e-send-jobs.ts`, `apps/api/test/e2e-import-jobs.ts`, `apps/api/test/e2e-research-jobs.ts`, any other `GraphClient` literal that `npm run typecheck` reports
- Test: `apps/api/test/graphClient.test.ts`, `apps/api/test/e2eGraph.test.ts`

**Interfaces:**
- Produces:
  - `GraphMessage.flag: { status: 'notFlagged' | 'flagged' | 'complete'; due: string | null }`: `flag` is added to `SYNC_FIELDS`, and `due` is the `YYYY-MM-DD` of `flag.dueDateTime.dateTime` (null when absent).
  - `export interface GraphAttachment { id: string; name: string; contentType: string; size: number; isInline: boolean; kind: 'file' | 'item' | 'reference' }`
  - `export type GraphFlag = { status: 'notFlagged' } | { status: 'complete' } | { status: 'flagged'; start: string | null; due: string | null; timeZone: string }`
  - `GraphClient` changes: `attachmentNames` is **removed**; added `listAttachments(account, graphId): Promise<GraphAttachment[]>` (`/attachments?$select=id,name,contentType,size,isInline`, `kind` from `@odata.type`); `attachmentContent(account, graphId, attachmentId: string, maxBytes: number): Promise<Buffer>` (`/attachments/{encodeURIComponent(id)}/$value`; a `Content-Length` or body over `maxBytes` → `GraphError('attachment_too_large', 413)`); `moveTo(account, graphId, folder: 'inbox' | 'archive' | 'deleteditems')` (widened); `setFlag(account, graphId, flag: GraphFlag): Promise<void>` (PATCH `{ flag: { flagStatus, startDateTime?, dueDateTime? } }`, each date as `{ dateTime: '<day>T00:00:00', timeZone }`, both dates sent together as Graph requires); `deleteMessage(account, graphId): Promise<void>` (DELETE); `replyAll(account, graphId, msg: { to: string[]; cc?: string[]; html: string })` (`/replyAll`, same body shape as `reply`); `forward(account, graphId, msg: { to: string[]; cc?: string[]; html: string })` (`/forward` with `comment` and `toRecipients`/`ccRecipients`).
  - `graph/e2eFake.ts`: `export function createE2eGraph(): GraphClient`. It accepts `markRead`, `moveTo`, `setFlag`, `deleteMessage`, `reply`, `replyAll` and `forward`. `listAttachments` returns one `orbit-notes.pdf` (`id 'e2e-att-1'`, `application/pdf`) for graphId `e2e-2` and `[]` otherwise. `attachmentContent` returns a minimal valid PDF (`%PDF-1.4` … `%%EOF`). Everything else rejects with `Error('not used in e2e')`. Also `export function isE2eGraph(g: GraphClient): boolean`, backed by a module `WeakSet`.
  - `app.ts`: `opts.graph ?? (env.E2E_FAKE_GRAPH === '1' && env.NODE_ENV === 'test' ? createE2eGraph() : createGraphClient(env))`.

- [ ] **Step 1: Write the failing tests**

```ts
// graphClient.test.ts (stubbed fetch, as the existing cases)
test('deltaPage maps flag status and due day', async () => {
  // value[0].flag = { flagStatus: 'flagged', dueDateTime: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' } }
  expect(page.messages[0]!.flag).toEqual({ status: 'flagged', due: '2026-11-27' });
});
test('setFlag sends flagStatus with start and due in the given zone; noDate sends neither; complete and clear only the status', ...
  expect(body).toEqual({ flag: { flagStatus: 'flagged', startDateTime: { dateTime: '2026-11-26T00:00:00', timeZone: 'Asia/Kolkata' }, dueDateTime: { dateTime: '2026-11-27T00:00:00', timeZone: 'Asia/Kolkata' } } });
test('moveTo deleteditems posts destinationId deleteditems with immutable ids', ...
test('deleteMessage sends DELETE on the message', ...
test('listAttachments maps id, name, type, size, inline and kind', ...
  expect(list).toEqual([{ id: 'AAMk=', name: 'RFP.pdf', contentType: 'application/pdf', size: 2400000, isInline: false, kind: 'file' }]);
test('attachmentContent refuses a file over the cap with 413 before reading it all', ...
test('replyAll and forward post comment and recipients to /replyAll and /forward', ...
// e2eGraph.test.ts
test('the e2e fake is used only with E2E_FAKE_GRAPH=1 and NODE_ENV test', async () => {
  // env NODE_ENV=test + flag → isE2eGraph(app.graph) true; NODE_ENV=production + flag → false; test without flag → false
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/graphClient.test.ts test/e2eGraph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the client methods, the fake and the app wiring. Replace `attachmentNames` with `listAttachments` in every fake (each new method there is `unexpected(...)` / `refuse`). The sync call site moves in Task 4; until then `syncMailbox.ts` uses `listAttachments(...).then((a) => a.map((x) => x.name))`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/graphClient.test.ts test/e2eGraph.test.ts test/syncMailbox.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/graph apps/api/src/app.ts apps/api/src/jobs/handlers/syncMailbox.ts apps/api/test apps/web/e2e/start-server.sh
git commit -m "feat(graph): flags, move to Deleted Items, delete, attachment list and content, reply all, forward; e2e fake"
```

---

### Task 4: Sync keeps Outlook's flags, size and attachment names

**Files:**
- Modify: `apps/api/src/jobs/handlers/syncMailbox.ts` (`storeMessage`)
- Test: `apps/api/test/syncMailbox.test.ts`, `apps/api/test/mailBackfill.test.ts` (fakes only)

**Interfaces:**
- Consumes: Task 3 `GraphMessage.flag`, `listAttachments`.
- Produces: new rows store `flagStatus`, `flagDue` (`dateOnly(due)`), `attachmentNames` = names of non-inline attachments, `sizeBytes = Buffer.byteLength(m.body.content) + Σ size of all attachments`. An existing row is updated with `flagStatus`/`flagDue` as well as `folder`/`isRead` (a flag set or cleared in Outlook shows on the next sync). `listAttachments` is called only when `m.hasAttachments` (a failure → names `[]`, size of the body only).

- [ ] **Step 1: Write the failing tests**

```ts
test('a new message keeps its flag, its non-inline attachment names and its size', async () => {
  // msg({ hasAttachments: true, flag: { status: 'flagged', due: '2026-11-27' }, body 1000 bytes }); listAttachments → RFP.pdf (2000, file) + logo.png (300, inline)
  expect(row).toMatchObject({ flagStatus: 'flagged', attachmentNames: ['RFP.pdf'], sizeBytes: 3300 });
  expect(ymd(row.flagDue)).toBe('2026-11-27');
});
test('a flag cleared in Outlook clears it on the stored row at the next sync', ...
  expect(row).toMatchObject({ flagStatus: 'notFlagged', flagDue: null });
test('a message without attachments costs no attachment call', ... expect(calls).toBe(0);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/syncMailbox.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block, and update the `storeMessage` doc comment.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/syncMailbox.test.ts test/mailBackfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/handlers/syncMailbox.ts apps/api/test/syncMailbox.test.ts apps/api/test/mailBackfill.test.ts
git commit -m "feat(mail): sync stores Outlook flags, message size and attachment names"
```

---

### Task 5: Two-way mailbox changes (single and bulk)

**Files:**
- Create: `apps/api/src/mail/changes.ts`
- Modify: `apps/api/src/routes/mail.ts` (new routes; `/read` and `/archive` delegate), `apps/api/src/app.ts` (error handler answers `MailChangeError`)
- Test: `apps/api/test/mailChanges.test.ts` (new), `apps/api/test/mail.test.ts` (read/archive cases: Graph is called inline, no `mail_action` job), `apps/api/test/mailTeam.test.ts`

**Interfaces:**
- Consumes: Task 2 `MailChange`, `MailBulk`, `flagDueDay`, `localNow`; Task 3 `moveTo`, `setFlag`, `deleteMessage`, `markRead`; release 1 `messageFor`.
- Produces (`mail/changes.ts`):
  - `export class MailChangeError extends Error { constructor(readonly code: 'mailbox_not_connected' | 'outlook_refused' | 'outlook_busy' | 'sending' | 'draft', readonly status: 409 | 502 | 503) }`
  - `export interface ChangedMessage { id: number; folder: string; isRead: boolean; flagStatus: string; flagDue: string | null; removed: boolean }`
  - `export async function changeMessage(graph: GraphClient, user: AuthUser, m: EmailMessage, change: MailChange, now?: Date): Promise<ChangedMessage>`. Order: refuse first (`status` queued/sending → `sending`; a draft moved → `draft`), then Graph on the row's own account (personal, connected, `userId === m.userId`, else `mailbox_not_connected`), then the CRM row. `delete` on a row not in `deleted` = move to `deleteditems`. `delete` on a row in `deleted` = `deleteMessage` in Outlook and the CRM row removed (`removed: true`). A row without `graphId` (CRM-only) skips Graph. Graph errors: auth failure → account `status: 'error'` (as `mailAction.ts`) + `mailbox_not_connected`; 429/≥500/504 → `outlook_busy`; any other `GraphError` → `outlook_refused`. Flag presets use `localNow(user.timezone, now).day` and `GraphFlag` with `timeZone: user.timezone`.
  - `export async function changeMany(graph: GraphClient, user: AuthUser, ids: number[], change: MailChange, now?: Date): Promise<{ done: ChangedMessage[]; failed: { id: number; error: string }[] }>`. Each id goes through `messageFor(…, 'change')`; a `MailAccessError`, `NotFoundError` or `MailChangeError` becomes one `failed` entry (`view_only`, `not_found`, or its code). At most `BULK_CONCURRENCY = 4` Graph calls run at once.
- Produces (routes): `POST /mail/:id/change` (body `MailChange`) → `ChangedMessage`; `POST /mail/bulk` (body `MailBulk`) → `{ done, failed }`, always 200. `POST /mail/:id/read` and `/archive` keep their answers and call `changeMessage`. Opening a message (`GET /mail/:id`) still queues the `mail_action` 'read' job (unchanged).

- [ ] **Step 1: Write the failing tests** (`mailChanges.test.ts`; `buildApp({ graph: fakeGraph({...}) })`; rep Maya with a connected mailbox, admin Deepak)

```ts
it('move to Archive / Inbox / Deleted items calls Graph on the owner mailbox, then sets the folder', async () => {
  for (const [folder, graphFolder] of [['archive', 'archive'], ['inbox', 'inbox'], ['deleted', 'deleteditems']] as const) {
    const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'move', folder });
    expect(res.json()).toMatchObject({ id: m.id, folder, removed: false });
    expect(moves.at(-1)).toEqual([m.graphId, graphFolder]);
  }
});
it('Delete moves to Deleted items; Delete in Deleted items deletes in Outlook and removes the row', ...
  expect(deletes).toEqual([m.graphId]);
  expect(await prisma.emailMessage.findUnique({ where: { id: m.id } })).toBeNull();
it('Flag Tomorrow for an Asia/Kolkata user at 23:30 UTC flags their day after tomorrow (UTC) with their zone', ...
  expect(flags.at(-1)).toEqual([m.graphId, { status: 'flagged', start: '2026-11-27', due: '2026-11-28', timeZone: 'Asia/Kolkata' }]);
  expect(row).toMatchObject({ flagStatus: 'flagged' });
it('Mark complete, Clear flag, No date and read/unread change Outlook and the row', ...
it('Outlook refuses (404) or throttles (429): the row is unchanged and the answer is outlook_refused 502 / outlook_busy 503 (Review Focus 1)', async () => {
  // moveTo throws new GraphError('graph_request_failed status=404', 404), then status 429
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: 'outlook_refused' });
  expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).folder).toBe('inbox');
});
it('a revoked mailbox answers mailbox_not_connected and puts the account in error; a disconnected one changes nothing', ...
it('a CRM message still sending is 409 sending; a draft cannot be moved (409 draft) but can be deleted', ...
it('a CRM-only failed message (no Graph id) changes in the CRM without calling Graph', ...
it("another user's message: change is 403 view_only and Graph is not called", ...
it('bulk: own messages change, another user\'s are failed view_only, unknown ids not_found; at most 50 ids', async () => {
  expect(res.json()).toEqual({ done: [expect.objectContaining({ id: a.id }), expect.objectContaining({ id: b.id })], failed: [{ id: other.id, error: 'view_only' }, { id: 999999, error: 'not_found' }] });
  expect((await call('POST', '/api/mail/bulk', repCookie, { ids: Array.from({ length: 51 }, (_, i) => i + 1), change: { type: 'delete' } })).statusCode).toBe(400);
});
it('nothing about the mail is logged: no subject or address in the app log on a refusal', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build -w packages/shared && npm test -w apps/api -- test/mailChanges.test.ts`
Expected: FAIL (route not found).

- [ ] **Step 3: Implement** `changes.ts`, the routes, the error-handler line, and the doc comments (route header: "mailbox changes go to Outlook first, inline; a refusal changes nothing").

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailChanges.test.ts test/mail.test.ts test/mailTeam.test.ts`
Expected: PASS (the `mail.test.ts` case that expected `['unread', 'archive']` jobs now expects the two Graph calls and no job).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/changes.ts apps/api/src/routes/mail.ts apps/api/src/app.ts apps/api/test/mailChanges.test.ts apps/api/test/mail.test.ts apps/api/test/mailTeam.test.ts
git commit -m "feat(mail): delete, archive, move, flag and read/unread in the owner's Outlook, single and bulk"
```

---

### Task 6: Reply all and Forward through the send path

**Files:**
- Modify: `apps/api/src/mail/outgoing.ts` (`Outgoing.replyMode`, `replyRecipients`, `replySubject`), `apps/api/src/jobs/types.ts` (`SendUserEmailPayload.replyMode`), `apps/api/src/jobs/handlers/sendUserEmail.ts`, `apps/api/src/routes/mail.ts` (`POST /mail/:id/reply`)
- Test: `apps/api/test/mail.test.ts`, `apps/api/test/sendEmail.test.ts` (whichever holds the `sendUserEmailHandler` cases; add them where the reply case lives)

**Interfaces:**
- Consumes: Task 2 `MailReply` (`mode`, `to`); Task 3 `replyAll`, `forward`.
- Produces:
  - `export type ReplyMode = 'reply' | 'replyAll' | 'forward'`
  - `export function replyRecipients(original: EmailMessage, mode: ReplyMode, own: string[], bodyTo: string[]): { to: string[] }`: `reply` = sender of a received message, or the recipients of your own; `replyAll` = that set ∪ the original To, minus `own` (lower-cased, unique); `forward` = `bodyTo`. Cc is always the client's `cc` (the screen pre-fills the original Cc minus your own for Reply all).
  - `export function replySubject(subject: string, mode: ReplyMode): string`: `Re: ` unless it already starts with `re:`; for forward, `Fw: ` unless it already starts with `fw:`/`fwd:` (case-insensitive); 500 characters at most.
  - `SendUserEmailPayload.replyMode?: 'replyAll' | 'forward'` (absent = reply). `queueOutgoing` puts `o.replyMode` on the payload. The handler calls `graph.replyAll` / `graph.forward` when the original has a Graph id in the sender's own mailbox; otherwise `sendMail`, as for a reply today.
  - `own` = the sender's `account.address` and `account.sendAs`.

- [ ] **Step 1: Write the failing tests**

```ts
it('Reply all goes to the sender and the other To addresses, never your own; Cc as given; subject Re:', async () => {
  // received from ana@acme.com to [maya@daitpartners.com, bo@acme.com], cc [cy@acme.com]
  const res = await call('POST', `/api/mail/${m.id}/reply`, repCookie, { mode: 'replyAll', cc: ['cy@acme.com'], body: 'Thanks' });
  expect(res.json()).toMatchObject({ toAddresses: ['ana@acme.com', 'bo@acme.com'], ccAddresses: ['cy@acme.com'], subject: 'Re: Proposal' });
  expect((await prisma.job.findFirstOrThrow({ where: { type: 'send_user_email' } })).payload).toMatchObject({ replyMode: 'replyAll' });
});
it('Forward needs a To, keeps the conversation and lead, subject Fw: once', ...
  expect((await call(..., { mode: 'forward', body: 'x' })).statusCode).toBe(400);
  expect(created).toMatchObject({ toAddresses: ['new@acme.com'], subject: 'Fw: Proposal', replyToId: m.id, leadId: lead.id });
it("Reply all / Forward on another user's message are 403 view_only", ...
// handler
it('a queued Reply all / Forward is sent with Graph replyAll / forward on the original', ...
  expect(calls).toEqual([['replyAll', original.graphId, { to: [...], cc: [...], html: expect.any(String) }]]);
it('a forward of a CRM-only original (no Graph id) goes out with sendMail', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mail.test.ts test/sendEmail.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mail.test.ts test/sendEmail.test.ts test/quotationSend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/outgoing.ts apps/api/src/jobs apps/api/src/routes/mail.ts apps/api/test
git commit -m "feat(mail): Reply all and Forward from your own mailbox through Graph"
```

---

### Task 7: List — views, chips, filters, sort, conversations; folder counts

**Files:**
- Create: `apps/api/src/mail/list.ts`
- Modify: `apps/api/src/routes/mail.ts` (`GET /mail`, `GET /mail/meta`, `listItem`, `VIEWS`; `unlinkedWhere` removed)
- Test: `apps/api/test/mailList.test.ts` (new), `apps/api/test/mail.test.ts` and `apps/api/test/mailTeam.test.ts` (Unlinked cases removed or rewritten)

**Interfaces:**
- Consumes: Task 1 columns; Task 2 `MailListQuery`; release 1 `mailScope`, `awaitingIds`, `searchIds`.
- Produces (`mail/list.ts`):
  - `export const VIEWS = ['inbox', 'sent', 'drafts', 'scheduled', 'flagged', 'archive', 'deleted', 'awaiting', 'due', 'mine'] as const` (an unknown view, `unlinked` included, is `inbox`). `scheduled` = `source 'crm'`, status `queued`/`sending`. `flagged` = `flagStatus 'flagged'`, folder ≠ `deleted`. `due` = folder not `drafts`/`deleted`, lead open (status not in `CLOSED_STATUSES`) with `nextFollowUp ≤ today` (viewer's zone). `mine` = your own scope: `lead.assignedToId = viewer`; team scope (`mailOf` set): `leadId` not null; folder not `drafts`/`deleted` in both.
  - `export async function listWhere(user: AuthUser, scope: { where: Prisma.EmailMessageWhereInput; ownerId: number | null }, q: MailListQuery, now?: Date): Promise<Prisma.EmailMessageWhereInput>`. It contains everything the route builds today (view, company, lead, project, `s`), plus: `chip` unread → `isRead false`, flagged → `flagStatus 'flagged'`, attachments (or `attachments=1`) → `attachmentNames` not `[]`; `from` → `from_address`/`from_name` ILIKE; `to` → `to_addresses::text` ILIKE; `subject` ILIKE; `leadQ` → the lead's number contains it, or (leads the viewer can see) its company name contains it; `owner` → `lead.assignedToId` (`me` = viewer); `date` → `occurredAt ≥ startOfDayIn(day, user.timezone)` for today / −6 / −29 / −364 days, `custom` → `since`..`until` inclusive. ILIKE input is escaped as in `searchIds`.
  - `export type ListSort = 'date' | 'from' | 'lead' | 'stage' | 'size'`
  - `export interface Candidate { id: number; userId: number; threadId: string | null; occurredAt: Date; fromKey: string; leadNumber: string | null; stageRank: number | null; sizeBytes: number }`
  - `export function orderCandidates(rows: Candidate[], sort: ListSort, dir: 'asc' | 'desc', conversation: boolean): Candidate[]`: sort by the key (`stageRank` = the `lead_status` lookup `sortOrder`; null keys last in either direction), ties newest first then id desc; then, with `conversation`, keep the first row per key `${userId}:${threadId ?? `id${id}`}`.
  - `export const LIST_CANDIDATES_MAX = 5000`
  - `export async function decorate(rows: EmailMessage[], scopeWhere: Prisma.EmailMessageWhereInput): Promise<{ replied: Set<number>; counts: Map<string, number> }>`: `replied` = received rows with a later `sent`/`queued`/`sending` row of the same user and thread; `counts` = messages per conversation key within the scope (folder ≠ `deleted` unless the row itself is in `deleted`).
- Produces (route): `GET /mail` takes the fast path (today's direct paging) when `sort` is `date` and `conv=0`. Otherwise it reads up to `LIST_CANDIDATES_MAX` candidates (minimal `select`), applies `orderCandidates`, pages the result, and reads the page's full rows by id; `total` counts rows after grouping. List items gain `flagStatus`, `flagDue` (`YYYY-MM-DD` | null), `replied: boolean`, `conversationCount: number`, `leadStatus: string | null` (null when `leadRestricted`). `GET /mail/meta` drops `unlinked` and gains `counts: { inbox: number; drafts: number; scheduled: number; flagged: number; awaiting: number; due: number; leads: number }` (inbox = unread; due and leads = distinct leads with mail in the scope; the others = messages) and `leadOwners: { id: number; name: string }[]` (active users, by name).

- [ ] **Step 1: Write the failing tests**

```ts
test('orderCandidates groups by owner and conversation: two mailboxes stay two rows, no thread is its own row (Review Focus 3)', () => {
  const rows = [cand({ id: 5, userId: 1, threadId: 't' }), cand({ id: 4, userId: 2, threadId: 't' }), cand({ id: 3, userId: 1, threadId: 't' }), cand({ id: 2, userId: 1, threadId: null }), cand({ id: 1, userId: 1, threadId: null })];
  expect(orderCandidates(rows, 'date', 'desc', true).map((r) => r.id)).toEqual([5, 4, 2, 1]);
  expect(orderCandidates(rows, 'date', 'desc', false)).toHaveLength(5);
});
test('sort by from, lead, stage and size, either direction, missing keys last', ...
it('conversation view: one row per conversation, the newest, with its count; total counts rows (Review Focus 3)', async () => {
  const body = (await call('GET', '/api/mail?view=inbox', repCookie)).json();
  expect(body.total).toBe(2);
  expect(body.items[0]).toMatchObject({ subject: 'Re: Proposal', conversationCount: 3 });
  expect((await call('GET', '/api/mail?view=inbox&conv=0', repCookie)).json().total).toBe(3);
});
it('team view (Everyone): the same conversation in two mailboxes is two rows, each with its owner', ...
it('chips Unread, Flagged and Attachments narrow the list', ...
it('filters From, To, Subject, Lead (number or company), Owner (lead owner) and Date (today in the user zone), with Has attachments', ...
it('views Scheduled, Flagged, Follow-up due today and My leads / Team leads', ...
it('items carry replied, flag, conversation count and lead status; restricted leads give no status', ...
it('meta: counts per folder and Leads group, lead owners; no unlinked', async () => {
  expect(meta.counts).toEqual({ inbox: 1, drafts: 1, scheduled: 1, flagged: 1, awaiting: 1, due: 1, leads: 2 });
  expect(meta).not.toHaveProperty('unlinked');
});
it('?view=unlinked falls back to Inbox', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailList.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `list.ts` and the route changes. Remove the Unlinked view and its count, and update the route comments.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailList.test.ts test/mail.test.ts test/mailTeam.test.ts test/navCounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/list.ts apps/api/src/routes/mail.ts apps/api/test
git commit -m "feat(mail): web-mail list — folders, Leads views, chips, filters, sort and conversation view"
```

---

### Task 8: Reading — conversation and lead panel

**Files:**
- Create: `apps/api/src/mail/leadPanel.ts`
- Modify: `apps/api/src/routes/mail.ts` (`threadHistory`, `GET /mail/:id`)
- Test: `apps/api/test/mailReading.test.ts` (new), `apps/api/test/mail.test.ts` (thread-history shape)

**Interfaces:**
- Consumes: release 1 `messageFor`, `canSeeLead`, `restrictedLead`; `activityRow`, `activityInclude`, `TimelineViewer` (leads/serialize.ts); `quoteTotals` (shared).
- Produces:
  - Each `thread` item also carries `fromName`, `fromAddress`, `toAddresses`, `ccAddresses`, `preview` (120 characters, as the list), `hasAttachments`, `folder`, `isRead`.
  - `export interface LeadPanel { company: { id: number; name: string; site: string | null; place: string | null } | null; contact: { name: string; role: string | null; email: string | null; phone: string | null } | null; owner: string | null; followUp: { date: string; time: string | null; due: boolean } | null; lastActivity: { title: string; occurredAt: string } | null; value: { amount: number; currency: string } | null; recent: ReturnType<typeof activityRow>[]; linkReason: { kind: 'address' | 'domain'; value: string } | null }`
  - `export async function leadPanel(db: Db, user: AuthUser, leadId: number, participants: string[], now?: Date): Promise<LeadPanel>`: `site` = company domain; `place` = `city, country`; `phone` = contact phone, else mobile, else the lead's; `followUp` = the open `follow_up` task's `dueDate` + `dueTime` when there is one, else the lead's `nextFollowUp`, with `due` = date ≤ today (viewer's zone); `lastActivity` = the newest activity; `value` = `quoteTotals` total of the lead's newest non-Draft quotation; `recent` = the three newest activities through `activityRow` with the viewer's `TimelineViewer`; `linkReason` = `address` when a participant equals the lead's or the contact's email, else `domain` when a participant's domain is the company domain.
  - `GET /mail/:id` adds `leadPanel: LeadPanel | null` (null when there is no lead or the lead is restricted, so a restricted lead keeps `restrictedLead` only).

- [ ] **Step 1: Write the failing tests**

```ts
it('thread items carry who, to, cc, preview, attachments, folder and read state, newest first', ...
  expect(body.thread.map((t) => t.subject)).toEqual(['Re: Proposal', 'Proposal']);
  expect(body.thread[1]).toMatchObject({ fromAddress: 'maya@daitpartners.com', toAddresses: ['ana@acme.com'], preview: expect.any(String), folder: 'sent' });
it('lead panel: company, contact, owner, follow-up from the open task with its time, due when today, last activity, value, recent three, link reason', async () => {
  expect(body.leadPanel).toMatchObject({
    company: { name: 'Acme Logistics', site: 'acme.com', place: 'Chicago, United States' }, contact: { name: 'Ana Ruiz', email: 'ana@acme.com' },
    owner: 'Maya Pillai', followUp: { date: today, time: '16:00', due: true }, value: { amount: 48000, currency: 'USD' }, linkReason: { kind: 'address', value: 'ana@acme.com' },
  });
  expect(body.leadPanel.recent).toHaveLength(3);
});
it("a Sales rep's message on another owner's lead has no lead panel (restrictedLead only)", ...
it("team view: the lead panel's recent email lines show subjects (Administrator), and opening stays audited without content", ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailReading.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block (the panel queries run in the existing `Promise.all`).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailReading.test.ts test/mail.test.ts test/mailTeam.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/leadPanel.ts apps/api/src/routes/mail.ts apps/api/test
git commit -m "feat(mail): conversation details and the lead panel in the reading endpoint"
```

---

### Task 9: Attachments — list, preview, download through the server

**Files:**
- Create: `apps/api/src/mail/attachments.ts`
- Modify: `apps/api/src/routes/mail.ts`
- Test: `apps/api/test/mailAttachments.test.ts`

**Interfaces:**
- Consumes: Task 3 `listAttachments`, `attachmentContent`; `sniff` (mail/files.ts); `messageFor`.
- Produces:
  - `export const ATTACHMENT_PROXY_MAX_BYTES = 25_000_000; export const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif'] as const;`
  - `export async function attachmentsOf(graph: GraphClient, m: EmailMessage): Promise<{ available: boolean; items: { id: string; name: string; contentType: string; size: number; preview: boolean }[] }>`: non-inline `file` attachments only. `preview` comes from the name's extension (pdf/png/jpg/jpeg/gif); serving checks the bytes again. A row without `graphId`, or whose account is not the owner's connected one → `{ available: false, items: [] }`.
  - `export async function attachmentFile(graph: GraphClient, m: EmailMessage, attachmentId: string): Promise<{ name: string; data: Buffer; previewType: (typeof PREVIEW_TYPES)[number] | null }>` (`previewType` = `sniff(data, name)` when it is a PDF/PNG/JPEG/GIF, else null).
  - `GET /mail/:id/attachments` → the list. `GET /mail/:id/attachment?att=<id>&inline=1` → the bytes: `att` must match `/^[A-Za-z0-9+/=_-]{1,1024}$/` (else 404). `inline=1` with a `previewType` → `Content-Type: <previewType>`, `Content-Disposition: inline; filename=…`. Otherwise → `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`. Images also get `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox`, and downloads `default-src 'none'; sandbox`. Always `nosniff` and `private, no-store`. Graph 413 → `413 attachment_too_large`; other Graph errors → `502 outlook_refused` / `503 outlook_busy`. Team view (`viewOnly`) is allowed, and each download writes one audit row `{ entityType: 'email_message', entityId: m.id, action: 'view', userId, after: { ownerId: m.userId, attachment: true } }` (no file name). Rate limit `perUser(120)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists the non-inline file attachments with preview flags', ...
  expect(body).toEqual({ available: true, items: [{ id: 'A1', name: 'RFP.pdf', contentType: 'application/pdf', size: 9, preview: true }, { id: 'A2', name: 'Pricing.xlsx', contentType: expect.any(String), size: 4, preview: false }] });
it('Preview of a real PDF is inline application/pdf with nosniff and no-store', ...
it('a file named .pdf whose bytes are HTML is never inline: octet-stream attachment with a sandbox CSP (Review Focus 2)', async () => {
  // attachmentContent → Buffer.from('<html><script>alert(1)</script></html>'); name 'invoice.pdf'; ?inline=1
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toContain('sandbox');
});
it('a CRM-only message lists nothing (available false); a malformed att id is 404', ...
it('over 25 MB is 413 attachment_too_large', ...
it("an Administrator downloads another user's attachment (view only) and one audit row is written without the file name", ...
  expect(JSON.stringify(audits)).not.toContain('RFP');
it("a Sales rep asking for another user's attachment gets 404", ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailAttachments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailAttachments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/attachments.ts apps/api/src/routes/mail.ts apps/api/test/mailAttachments.test.ts
git commit -m "feat(mail): received attachments listed, previewed and downloaded from Outlook on demand"
```

---

### Task 10: CRM commands — Follow-up, Unlink, lead suggestions

**Files:**
- Create: `apps/api/src/mail/crm.ts`
- Modify: `apps/api/src/routes/mail.ts`
- Test: `apps/api/test/mailCrm.test.ts`

**Interfaces:**
- Consumes: Task 2 `MailFollowUp`; `syncFollowUpTask`, `lockLeads`, `assertLeadVisible`, `isClosedStatus`, `audit`.
- Produces:
  - `export async function setLeadFollowUp(tx: Tx, user: AuthUser, leadId: number, v: { date: string; time: string } | null): Promise<{ nextFollowUp: string | null; taskId: number | null }>`: locks the lead; a closed lead with a date → `RuleError('lead_closed')`; sets `nextFollowUp` (`dateOnly`); calls `syncFollowUpTask`; sets the open `follow_up` task's `dueTime = v.time`; audits `{ entityType: 'lead', action: 'update', before: { nextFollowUp }, after: { nextFollowUp, dueTime, emailMessageId } }`.
  - `export async function suggestLeads(db: Db, user: AuthUser, m: EmailMessage): Promise<{ id: number; number: string; companyName: string; status: string }[]>`: at most 5 leads the user can see (archived included), excluding `m.leadId`: first leads or contacts whose email is a participant (`participantsOf`), then leads of companies whose `domain` is a participant's domain (free mail, shared hosts, `OWN_MAIL_DOMAINS` excluded as in leadMail.ts); open leads first, then `updatedAt` desc.
  - `POST /mail/:id/follow-up` (body `MailFollowUp`, `messageFor(…, 'crm')`, needs `manage_leads` else 403 `forbidden`; no lead or a lead the viewer cannot see → 409 `no_lead`) → `{ leadId, nextFollowUp, taskId }`. `POST /mail/:id/unlink` (`'change'`) → `leadId`, `contactId`, `companyId` null on that message only → `{ id, leadId: null }`. `GET /mail/:id/lead-suggestions` (`'change'`) → `{ items }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('Follow-up sets the lead date and the follow-up task time; Clear removes both', async () => {
  await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
  expect(ymd((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp)).toBe('2026-11-30');
  expect(await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } })).toMatchObject({ dueTime: '09:00' });
  await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { clear: true });
  expect(await prisma.task.count({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } })).toBe(0);
});
it('Follow-up on a closed lead is 409 lead_closed; without manage_leads 403; an Administrator in team view may set it', ...
it('Unlink clears the message links only; another user\'s message is 403 view_only', ...
it('suggestions: address matches first, then the company domain, visible leads only, never free mail, at most 5', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailCrm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailCrm.test.ts test/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/crm.ts apps/api/src/routes/mail.ts apps/api/test/mailCrm.test.ts
git commit -m "feat(mail): lead follow-up from an email, unlink, lead suggestions"
```

---

### Task 11: Web foundations — API hooks, icons, dates, command fitting

**Files:**
- Modify: `apps/web/src/api/mail.ts`, `apps/web/src/components/Icons.tsx`, `apps/web/src/i18n/labels.ts` (`errorText`)
- Create: `apps/web/src/pages/email/mailDates.ts`, `apps/web/src/pages/email/fitCommands.ts`, `apps/web/src/pages/email/replyStart.ts`
- Modify: `apps/web/src/locales/es.json`, `fr.json`
- Test: `apps/web/test/mailDates.test.ts`, `apps/web/test/fitCommands.test.ts`, `apps/web/test/mailHooks.test.tsx`

**Interfaces:**
- Consumes: Tasks 5–10 response shapes.
- Produces (`api/mail.ts`):
  - `MAIL_VIEWS = ['inbox', 'sent', 'drafts', 'scheduled', 'flagged', 'archive', 'deleted', 'awaiting', 'due', 'mine'] as const`
  - `MailFilter` gains `chip?, conv?: boolean, sort?: ListSort, dir?: 'asc' | 'desc', from?, to?, subject?, leadQ?, owner?: 'me' | number, date?, since?, until?, attachments?: boolean`, all sent by `listPath` only when set (`conv` sent as `conv=0` only when false).
  - Types `MailItem` + `flagStatus`, `flagDue`, `replied`, `conversationCount`, `leadStatus`; `MailDetail` + extended `thread` items + `leadPanel: LeadPanel | null`; `MailMeta` − `unlinked` + `counts`, `leadOwners`; `ChangedMessage`; `MailChange` (re-exported from shared).
  - `useMailChange()`: mutation `{ id, change }` → `POST /api/mail/:id/change`. `onMutate` patches every cached list batch and the detail (a move or delete drops the row from lists whose view no longer holds it; read and flag patch it in place) and keeps a snapshot. `onError` restores the snapshot and toasts `errorText(code)` (Review Focus 1). `onSettled` invalidates meta and nav counts.
  - `useBulkMailChange()`: `{ ids, change }` → `POST /api/mail/bulk`, optimistic like `useMailChange`. Failed ids are restored, with the toast `{n} could not be changed in Outlook`.
  - `useMailFollowUp()`, `useUnlinkMail()`, `useLeadSuggestions(id: number | null)`, `useMailAttachments(id: number | null, enabled: boolean)`, `attachmentUrl(id: number, att: string, inline: boolean): string`.
  - `useReplyMail` takes `{ id, mode, to, cc, body, bodyHtml }`.
- Produces (`mailDates.ts`): `export type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'older'`; `export function dateGroup(iso: string, timezone: string, now?: Date): DateGroup` (weeks start on Monday); `export function rowTime(iso: string, timezone: string, language: string, now?: Date): string` (today `14:05`; yesterday `Yesterday 17:46` translated; otherwise `Fri 20 Nov`).
- Produces (`fitCommands.ts`): `export function fitCommands(full: number[], compact: number[], available: number): { compact: boolean; visible: number }`. Everything fits at full width → `{ compact: false, visible: n }`; else the compact widths are tried; `visible` = how many leading items fit (the rest go to "…"); a trailing separator never stays visible.
- Produces (`replyStart.ts`): `export function replyStart(m: { id: number; status: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; subject: string; leadId: number | null; companyId: number | null }, mode: 'reply' | 'replyAll' | 'forward', ownAddress: string | null): ComposeStart`, mirroring the server's `replyRecipients` and `replySubject` for display (Reply all pre-fills Cc with the original Cc minus your own address).
- Icons: add `trash, archive, move, reply, replyall, forward, unread, eye, followup, link, activity, task, meeting, mailplus, filter, sync, inbox, draft, hourglass, users, clip, external, download, x, check, down, dbl, dblr, plus, template, smile` from the mockup's `P` map (same paths; the existing `Icons` element style).
- `errorText` cases: `outlook_refused` → `Outlook refused the change. Nothing was changed.`; `outlook_busy` → `Outlook is busy. Try again in a moment.`; `mailbox_not_connected` → `Your mailbox needs reconnecting in Settings.`; `sending` → `This email is still being sent.`; `draft` → `Drafts can only be deleted here.`; `attachment_too_large` → `This file is too large to open here. Open it in Outlook.`; `lead_closed` → (existing text if present).

- [ ] **Step 1: Write the failing tests**

```ts
// mailDates.test.ts (now Thu 26 Nov 2026 14:30 Europe/London)
test('groups: today, yesterday, earlier this week, last week, older', () => {
  expect(['2026-11-26T09:02:00Z', '2026-11-25T17:46:00Z', '2026-11-23T10:00:00Z', '2026-11-20T10:00:00Z', '2026-11-13T10:00:00Z'].map((d) => dateGroup(d, 'Europe/London', NOW)))
    .toEqual(['today', 'yesterday', 'thisWeek', 'lastWeek', 'older']);
});
test('rowTime: 24-hour today, Yesterday hh:mm, else weekday day month', () => {
  expect(rowTime('2026-11-26T14:05:00Z', 'Europe/London', 'en', NOW)).toBe('14:05');
  expect(rowTime('2026-11-20T10:00:00Z', 'Europe/London', 'en', NOW)).toBe('Fri 20 Nov');
});
// fitCommands.test.ts
test('all fit; else compact; else the tail goes to the overflow and no separator is left last', () => {
  expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 400)).toEqual({ compact: false, visible: 4 });
  expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 120)).toEqual({ compact: true, visible: 4 });
  expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 75)).toEqual({ compact: true, visible: 2 });
});
// mailHooks.test.tsx
it('useMailChange moves the row out of Inbox at once and puts it back with a toast when Outlook refuses (Review Focus 1)', ...
  // POST answers 502 { error: 'outlook_refused' }
  expect(screen.getByText('Outlook refused the change. Nothing was changed.')).toBeInTheDocument();
it('replyStart: Reply all to the sender and other To addresses without your own, Cc pre-filled; Forward empty To, Fw: subject', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/mailDates.test.ts test/fitCommands.test.ts test/mailHooks.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr for the new strings.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/mailDates.test.ts test/fitCommands.test.ts test/mailHooks.test.tsx && npm run typecheck`
Expected: PASS (the old screen keeps compiling; `MailMeta.unlinked` users are updated in Task 12).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): mail hooks with optimistic changes, web-mail icons, list dates, command fitting"
```

---

### Task 12: Screen shell — top bar, filters panel, folder pane

**Files:**
- Modify: `apps/web/src/pages/email/EmailPage.tsx` (becomes the layout: `.wm` root with top bar, command bar slot, panes)
- Create: `apps/web/src/pages/email/MailTopBar.tsx`, `apps/web/src/pages/email/FolderPane.tsx`
- Modify: `apps/web/src/styles/app.css` (replace the "Email screen (release 2B-2…)" block with the mockup's top bar, panes and folder-pane CSS, scoped under `.wm`; mockup-only variables `--fp`, `--ml`, `--pane` are defined on `.wm`), locales
- Test: `apps/web/test/emailPage.test.tsx` (fixtures updated; Unlinked, Smart views, folder Templates and "Show mail for" cases removed or rewritten)

**Interfaces:**
- Consumes: Task 11 types and hooks.
- Produces:
  - Address params: `folder`, `mailof`, `s`, `from`, `to`, `subject`, `leadq`, `owner`, `date`, `since`, `until`, `att`, `chip`, `conv`, `sort`, `dir`, plus `company`, `lead`, `project` (still accepted from links such as the Projects list's Email buttons, and shown in the list header as a removable chip `{name} ✕`). `EmailPage` builds one `MailFilter` from them.
  - `MailTopBar({ meta, mailOf, filter, onSearch, onFilters })`: the `Topbar` with title `Email`; sub line as today for your own mailbox but ending `lead mail only` (mockup), or the release-1 team line; a `role="search"` box `Search lead mail` with a `Filters` toggle (`aria-expanded`, `aria-controls`) opening the panel: From, To, Subject, Lead (`LD number or company`), Owner (`Anyone`, `Me`, then `meta.leadOwners`), Date (`Any time`, `Today`, `Last 7 days`, `Last 30 days`, `Last 12 months`, `Custom range…` showing two date inputs), `Has attachments`, buttons `Clear filters` and `Search`; then `Sync now` (or `Connect Microsoft 365`). The panel closes on Search, Esc or a click outside.
  - `FolderPane({ view, meta, mailOf, team, collapsed, onToggle, href })`: the `Mail of:` select (release 1, Administrator/Manager only); folders with mockup icons and counts: `Inbox` (`counts.inbox`), `Sent items`, `Drafts` (`counts.drafts`, muted), `Scheduled` (`counts.scheduled`, muted), `Flagged` (`counts.flagged`, muted), `Archive`, `Deleted items`; a `Leads` group with `Awaiting reply` (muted), `Follow-up due today` (hot), `My leads` / `Team leads` (in team view) with `counts.leads`; the release-1 footer note and its `Why?` popover; the « toggle (remembered).
  - The compose entry `?compose=1` keeps working.

- [ ] **Step 1: Write the failing tests** (update `META`/`item()` fixtures with the new fields first)

```tsx
it('folder pane: mockup folders with counts, the Leads group, no Unlinked, no Templates list', async () => {
  const pane = await screen.findByRole('navigation', { name: 'Mail folders' });
  expect(within(pane).getAllByRole('link').map((l) => l.textContent)).toEqual(['Inbox3', 'Sent items', 'Drafts2', 'Scheduled1', 'Flagged4', 'Archive', 'Deleted items', 'Awaiting reply6', 'Follow-up due today3', 'My leads58']);
  expect(within(pane).queryByText('Unlinked')).toBeNull();
});
it('team view names the Leads view Team leads', ...
it('Filters panel: From, To, Subject, Lead, Owner, Date, Has attachments; Search puts them in the address and the request', async () => {
  await user.click(screen.getByRole('button', { name: 'Filters' }));
  await user.type(screen.getByLabelText('From'), 'maria');
  await user.selectOptions(screen.getByLabelText('Date'), 'Last 7 days');
  await user.click(screen.getByRole('checkbox', { name: 'Has attachments' }));
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(screen.getByTestId('where').textContent).toContain('from=maria');
  expect(lastListUrl()).toMatch(/from=maria.*date=7d.*attachments=1|attachments=1.*from=maria/);
});
it('Custom range shows two date inputs; Clear filters empties the panel and the address', ...
it('Search lead mail submits s; Esc closes the panel', ...
it('a Projects-list link (?company=&project=) narrows the list and shows a removable chip', ...
it('top bar sub line ends "lead mail only"; Sync now as before', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailPage.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** the layout, the two components, the CSS and the translations. Until Tasks 13–16 land, the list and reader slots keep the existing `MessageRow` / `Reader`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/emailPage.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/emailPage.test.tsx
git commit -m "feat(web): web-mail top bar with search filters and the folder pane with Leads views"
```

---

### Task 13: Message list — chips, conversations, sort, groups, rows, multi-select, right-click menu

**Files:**
- Create: `apps/web/src/pages/email/MessageList.tsx`, `apps/web/src/pages/email/MessageRow.tsx`, `apps/web/src/pages/email/menus.tsx` (the `Menu` primitive + `MoveMenu`, `FlagMenu`), `apps/web/src/pages/email/useMailCommands.ts`
- Modify: `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/styles/app.css` (mockup "Message list" and "Menus" CSS under `.wm`), locales
- Test: `apps/web/test/emailList.test.tsx`

**Interfaces:**
- Consumes: Task 11 hooks, `dateGroup`, `rowTime`; Task 2 `flagDueDay`, `localNow`.
- Produces:
  - `export type CommandId = 'new' | 'delete' | 'archive' | 'move' | 'reply' | 'replyAll' | 'forward' | 'flag' | 'toggleRead' | 'followUp' | 'link' | 'log' | 'task' | 'meeting' | 'openLead'`
  - `export type MailTarget = { ids: number[]; item: MailItem | MailDetail | null }` (one message, or a multi-selection where `item` is null)
  - `useMailCommands(target: MailTarget | null, ctx: { connected: boolean; ownAddress: string | null; onCompose: (s: ComposeStart) => void }): { state: (id: CommandId) => { enabled: boolean; title?: string; label?: string }; run: (id: CommandId, arg?: unknown) => void }`. Rules: no target → only `new`. `viewOnly` → mailbox commands and `link` disabled, title `View only — {first}'s mailbox`. Draft → only `delete`. `queued`/`sending` → mailbox commands disabled, title `Still sending`. CRM commands need a visible lead (`leadId`), and `followUp` also needs `manage_leads`. A multi-selection enables only `delete`, `archive`, `move`, `flag`, `toggleRead`. `toggleRead` is labelled `Mark as unread` when the message is read, `Mark as read` when unread (a multi-selection marks read). Delete in `Deleted items` asks `Delete permanently? It is removed from Outlook too.` (ConfirmDialog) first. `run` calls `useMailChange` / `useBulkMailChange` / `replyStart` + `onCompose` / existing `useMailAction` (log, task) / navigation (`/leads/:id`, `/calendar?new=1&lead=:id`).
  - `MessageList`: header with the view title, `{n} unread`, a `Conversation view` switch (on by default; off → `conv=0` in the address), a sort button (`By date` …) opening a menu (`Date`, `From`, `Lead`, `Lead stage`, `Size`, then `Newest on top` / `Oldest on top`, labelled `A to Z` / `Z to A` for From and Lead); chips `All`, `Unread`, `Flagged`, `Attachments` (address `chip`); group headers `Today`, `Yesterday`, `This week`, `Last week`, `Older` (date sort only); the infinite scroll of today; the empty text `No lead mail matches this filter.`
  - `MessageRow`: the stretched-link pattern. The row is a `div.mrow` holding a `Link` named by sender and subject (so `getByRole('link', { name: /subject/ })` still works), the avatar, which shows a checkbox `Select message` on hover or when any row is selected, the sender (bold when unread), the icons (replied `You replied`, attachment `Has attachments`, flag `Flagged`), the subject, the conversation count when > 1 (title `{n} messages in this conversation`), `rowTime`, the preview, the lead chip `LD-xxxx · {stage}` (restricted: release-1 text), the mailbox in team view (`Your mailbox` / `{first}'s mailbox`), and hover buttons `Delete`, `Archive`, `Flag`, `Mark as unread` (disabled in view only, with the title).
  - Selection: with ≥1 checked rows, a bulk bar replaces the list header: `{n} selected`, `Delete`, `Archive`, `Move to ▾`, `Flag ▾`, `Mark as read`, `Clear selection`.
  - Right-click on a row (mockup state 4) opens `RowMenu` at the pointer: `Reply`, `Reply all`, `Forward` | `Delete` (`Del`), `Archive` (`E`), `Move to ›` (submenu: Inbox, Archive, Deleted items), `Flag ›` (submenu: the seven flag items with their dates `Thu 26 Nov`), `Mark as unread` (`Ctrl+U`) | `Link to lead`, `Log as activity`, `Create task`, `Open lead`, all driven by `useMailCommands`. `Menu` is `role="menu"`, items are `menuitem`, arrow keys move, Esc and an outside click close it, and submenus open on hover or →.

- [ ] **Step 1: Write the failing tests**

```tsx
it('rows: unread bold, icons, count, 24-hour time, lead chip with stage; groups Today / Yesterday', async () => {
  const row = await screen.findByRole('link', { name: /James Whitaker.*Re: Discovery call/ });
  expect(row.closest('.mrow')).toHaveClass('unread');
  expect(within(row.closest('.mrow')!).getByTitle('4 messages in this conversation')).toHaveTextContent('4');
  expect(within(row.closest('.mrow')!).getByText('LD-1204 · Proposal')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday']);
});
it('chips and the Conversation view switch go into the request (chip=unread, conv=0)', ...
it('sort menu: Lead stage, Oldest on top → sort=stage&dir=asc; groups disappear', ...
it('hover Archive moves the row out at once and posts the change', ...
  expect(posts.at(-1)).toEqual({ url: '/api/mail/2/change', body: { type: 'move', folder: 'archive' } });
it('team view: hover actions disabled on another mailbox with the view-only title; row names the mailbox', ...
it('checking two rows shows the bulk bar; Delete posts one bulk request for both', ...
  expect(posts.at(-1)).toEqual({ url: '/api/mail/bulk', body: { ids: [1, 2], change: { type: 'delete' } } });
it('right-click opens the menu (state 4); Move to › opens Inbox / Archive / Deleted items; Esc closes it', ...
it('Delete in Deleted items asks to delete permanently first', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the components, the hook and the CSS, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/emailList.test.tsx test/emailPage.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): web-mail message list with conversations, sort, groups, hover actions, multi-select and right-click menu"
```

---

### Task 14: Command bar, menus and keyboard shortcuts

**Files:**
- Create: `apps/web/src/pages/email/CommandBar.tsx`, `apps/web/src/pages/email/useMailShortcuts.ts`
- Modify: `apps/web/src/pages/email/menus.tsx` (+ `NewMailMenu`, `FollowUpMenu`, `LinkMenu`), `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/styles/app.css` (mockup "Command bar" CSS), locales
- Test: `apps/web/test/emailCommands.test.tsx`

**Interfaces:**
- Consumes: Task 13 `useMailCommands`, `Menu`; Task 11 `fitCommands`, `useMailFollowUp`, `useUnlinkMail`, `useLeadSuggestions`; `useTemplates`; Task 2 `followUpChoices`, `localNow`.
- Produces:
  - `CommandBar({ target, commands, view })`: tabs `Home` / `View` (`role="tablist"`). Home holds the split `New mail` + `▾` (`More new mail options`), then `Delete`, `Archive`, `Move to ▾` | `Reply`, `Reply all`, `Forward` | `Flag ▾`, `Mark as unread` (or `Mark as read`) | the orange CRM commands `Follow-up ▾` (title `Set the lead's next follow-up date (CRM)`), `Link to lead ▾`, `Log as activity`, `Create task`, `Schedule meeting`, then `…` (`More commands`). The overflow menu holds the commands that do not fit, then `Open lead`. A `ResizeObserver` feeds `fitCommands`, and compact mode shows icons only, with `aria-label` and `title`. View holds `Conversation view` (switch), `Sort by ▾`, `Folder pane` and `Lead panel` (show/hide).
  - `NewMailMenu`: `New mail`; heading `New from template`, then the real templates (`useTemplates`, the user's language first, all of them, a `.oft` marker), each opening `ComposeModal` filled the way today's folder template list fills it; `Manage templates…` → `/settings/templates`.
  - `FollowUpMenu({ item })`: heading `Lead follow-up · {lead}`, then the `followUpChoices` with their `{day}, {time}`, `Choose date and time…` (a small dialog with a date input and a 24-hour time input), `Clear follow-up`, and the note `Sets the lead's next follow-up and adds it to Tasks. Replaces Outlook's Snooze.`; posts `useMailFollowUp`; the toast is `Follow-up set for {when}`.
  - `LinkMenu({ item })`: a search field `Search leads by LD number or company` (the existing leads search, debounced), the heading `Suggested from the address` with `useLeadSuggestions`, each `{number} · {company}` with its stage; `Create lead from this email…` (opens the existing `LinkLeadModal`), `Unlink` (when linked). Linking uses the existing `/link`.
  - `useMailShortcuts(run: (id: CommandId) => void, opts: { enabled: boolean; onEscape: () => void })`: binds `Delete` → `delete`, `e` → `archive`, `Ctrl/⌘+U` → `toggleRead` (unread), `r` → `reply`, `Shift+R` → `replyAll`, `f` → `forward`, `n` → `new`, `Escape` → `onEscape`. It ignores events whose target is an input, textarea, select or `[contenteditable]`, and events while a `[role="dialog"]` is open. A disabled command does nothing.

- [ ] **Step 1: Write the failing tests**

```tsx
it('New mail ▾ lists the real templates (your language first) and Manage templates…', async () => {
  await user.click(screen.getByRole('button', { name: 'More new mail options' }));
  const menu = screen.getByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New mail', 'Intro', 'Intro ES', 'Manage templates…']);
});
it('Flag ▾ Tomorrow posts flag tomorrow; Move to ▾ Deleted items posts move deleted', ...
it("view only: Delete, Archive, Move, Reply, Reply all, Forward, Flag, Mark as unread and Link to lead disabled with the title; Follow-up, Log, Create task, Schedule meeting enabled", ...
  expect(screen.getByRole('button', { name: 'Reply all' })).toHaveAttribute('title', "View only — Carlos's mailbox");
it('Follow-up ▾ at 14:30: Later today 17:00 … posts date and time; Clear follow-up posts clear', ...
it('Link to lead ▾: suggestions from the address link the message; Unlink posts unlink', ...
it('Reply all and Forward open Compose with the computed To/Cc and subject', ...
it('Schedule meeting opens the calendar for the lead', ...
it('shortcuts: E archives, Ctrl+U marks unread, Shift+R opens Reply all, N opens New mail, Delete deletes', ...
it('shortcuts never fire while typing in the search box, a filter field, the Link search or Compose (Review Focus 4)', async () => {
  await user.type(screen.getByRole('searchbox', { name: 'Search lead mail' }), 'ern{Delete}');
  expect(posts).toEqual([]);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('overflow: with little room the tail commands move into … and the labels become icons with titles', ...
  // stub ResizeObserver + offsetWidth: available 400 → Schedule meeting is a menuitem of More commands
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailCommands.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the bar, the menus and the shortcuts hook, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/emailCommands.test.tsx test/emailList.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): web-mail command bar with New from template, Flag, Move, CRM commands, overflow and shortcuts"
```

---

### Task 15: Reading pane — conversation, attachments, auto-height HTML, compose modes

**Files:**
- Create: `apps/web/src/pages/email/ReadingPane.tsx`, `apps/web/src/pages/email/ConversationMessage.tsx`, `apps/web/src/pages/email/AttachmentCards.tsx`
- Delete: `apps/web/src/pages/email/Reader.tsx`
- Modify: `apps/web/src/pages/email/MailBody.tsx` (prop `autoHeight`), `apps/web/src/pages/email/ComposeModal.tsx` (`ComposeStart.mode`, `cc`), `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/styles/app.css` (mockup "Reading pane" CSS), locales
- Test: `apps/web/test/emailReading.test.tsx`, `apps/web/test/composeReply.test.tsx`; `apps/web/test/emailPage.test.tsx` (reader cases move to the new file; the sandbox case keeps `mailer.test.tsx`'s rule)

**Interfaces:**
- Consumes: Task 8 `thread` items; Task 9 `useMailAttachments`, `attachmentUrl`; Task 11 `replyStart`; Task 13 `useMailCommands`.
- Produces:
  - `ReadingPane({ id, peek, commands })`: the head shows the subject (`h2`), the lead chip `LD-xxxx · {stage}`, the company, `{n} messages`, and in team view the mailbox. Then the release-1 view-only banner. Then the conversation newest on top: the opened message is a `ConversationMessage` (expanded), the others are collapsed rows (avatar, sender, preview, date, chevron) that expand on click (fetching that message with `useMailMessage(otherId)`) and collapse on a click on the sender. Under the newest message come the footer buttons `Reply`, `Reply all`, `Forward`, or in view only the release-1 pill + `Log as activity` + `Create task`.
  - `ConversationMessage({ m, viewOnly, commands })`: the header shows the avatar, `{name} <{address}>`, `To: … · Cc: …` and the date (24-hour). Per-message buttons `Reply`, `Reply all`, `Forward` and `More actions` (opens `RowMenu` for that message); in view only, `Log as activity` and `More actions`. Then `AttachmentCards`, then the body.
  - `AttachmentCards({ messageId, names })`: a file-type badge (`PDF`, `XLSX`, `DOCX` … from the extension), the name, the size, `Preview` (a link to `attachmentUrl(id, att, true)`, `target="_blank" rel="noopener"`, only when `preview`) and `Download` (a link to `attachmentUrl(id, att, false)`, `download`). The list loads only once the message is expanded. `available: false` shows the names without links (`Not in Outlook yet`).
  - `MailBody({ html, text, autoHeight })`: with `autoHeight`, sandbox `allow-same-origin allow-popups allow-popups-to-escape-sandbox` (never `allow-scripts`). The height is set from `contentDocument.documentElement.scrollHeight` on load and when the frame's body resizes (`ResizeObserver`), and the frame does not scroll itself. Without `autoHeight` it is unchanged (Mailer, lead page).
  - `ComposeStart` gains `mode?: 'reply' | 'replyAll' | 'forward'` and `cc?: string`. The title is `Reply` / `Reply all` / `Forward`. To is read-only for reply/reply all and editable (required) for forward. The subject is fixed. Send posts `useReplyMail({ id, mode, to, cc, body, bodyHtml })`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('conversation newest on top: the opened message expanded, older ones collapsed and expandable', async () => {
  const pane = await screen.findByRole('region', { name: 'Reading pane' });
  const articles = within(pane).getAllByRole('article');
  expect(articles).toHaveLength(1);
  expect(within(pane).getAllByRole('button', { name: /Maria Gómez|Deepak Singh/ }).map((b) => b.textContent)).toEqual([expect.stringContaining('21 Nov 2026, 16:40'), expect.stringContaining('19 Nov 2026, 10:12')]);
  await user.click(within(pane).getAllByRole('button', { name: /Deepak Singh/ })[0]!);
  expect(await within(pane).findAllByRole('article')).toHaveLength(2);
});
it('attachment cards above the body with Preview (PDF only) and Download links through the API', ...
  expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/mail/1/attachment?att=A1');
  expect(screen.getAllByRole('link', { name: 'Preview' })).toHaveLength(1);
it('the Email screen frame is same-origin (no scripts) and takes its content height; the Mailer frame keeps no same-origin', ...
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox');
it('per-message Reply all opens Compose for that message', ...
it('view only: banner, footer pill, Log as activity and Create task; no Reply buttons enabled', ...
// composeReply.test.tsx
it('Forward: To required and editable, subject Fw:, posts mode forward with to', ...
it('Reply all: To read-only, Cc pre-filled, posts mode replyAll', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailReading.test.tsx test/composeReply.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the components, the `MailBody` prop and the Compose modes, with es/fr. Remove `Reader.tsx` and its now-unused strings.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web && npm run typecheck`
Expected: PASS (all web unit tests, `mailer.test.tsx` and `leadPage.test.tsx` frames unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src apps/web/test
git commit -m "feat(web): conversation reading pane, attachment cards, auto-height HTML, Reply all and Forward in Compose"
```

---

### Task 16: Lead panel

**Files:**
- Create: `apps/web/src/pages/email/LeadPanel.tsx`
- Modify: `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/styles/app.css` (mockup "Lead panel" CSS and the 1360 px rule), locales
- Test: `apps/web/test/leadPanel.test.tsx`

**Interfaces:**
- Consumes: Task 8 `leadPanel`, `restrictedLead`; Task 13 `useMailCommands`; Task 14 `FollowUpMenu`.
- Produces: `LeadPanel({ m, commands, collapsed, onToggle })` (`aria-label="Lead"`). The head shows `Lead` and the toggle (`Collapse lead panel` / `Expand lead panel`). Folded, it is a rail button `Lead · {number}`. Open, it shows: the logo initials, the company name and `{site} · {place}`, badges `{number}` and `{stage}`, then the rows `Contact` (name + role), `Email` (mailto link), `Phone`, `Owner`, `Next follow-up` (`{day}, {time}` with the class `due` and `· due` when due), `Last activity` (`{title} · {date time}`), `Value` (`US$ 48,000` formatted with the currency) or `—`. Then the buttons `Open lead` (primary), `Log as activity`, `Create task`, `Set follow-up` (opens `FollowUpMenu`); then `Recent on the lead` (three lines with time) and the note `Linked automatically: {value} belongs to this lead.` / `… is on this lead.` from `linkReason`. A restricted lead shows only the company name and `{lead} · another owner's lead`, with no buttons. No lead shows `No lead linked` with `Link to lead ▾`. Initial `collapsed` = `window.innerWidth < 1400`, toggled per visit; the HTML frame height is measured again after a toggle.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the lead details from the reading answer, follow-up red when due, the value and recent lines', async () => {
  const panel = await screen.findByRole('complementary', { name: 'Lead' });
  expect(within(panel).getByText('Acme Logistics')).toBeInTheDocument();
  expect(within(panel).getByText(/Today, 16:00 · due/)).toHaveClass('due');
  expect(within(panel).getByText('US$ 48,000')).toBeInTheDocument();
  expect(within(panel).getAllByRole('link', { name: 'Open lead' })[0]).toHaveAttribute('href', '/leads/5');
});
it('starts folded below 1400 px as a rail "Lead · LD-1178", opens on click', ...
it("another owner's lead: company name and the restricted chip only, no buttons", ...
it('Set follow-up opens the follow-up menu', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/leadPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the panel, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/leadPanel.test.tsx test/emailReading.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/leadPanel.test.tsx
git commit -m "feat(web): collapsible lead panel on the Email screen"
```

---

### Task 17: End-to-end flows and docs

**Files:**
- Modify: `apps/web/e2e/email.spec.ts`, `apps/web/e2e/emailFit.spec.ts`, `apps/web/e2e/emailHtml.spec.ts`, `apps/web/e2e/parity/mail.spec.ts`, `apps/web/e2e/projects.spec.ts` (only if its Compose path changed)
- Create: `apps/web/e2e/emailActions.spec.ts`
- Modify: `docs/PENDING.md`, `docs/DEPLOYMENT.md` (release 2 has no one-time step beyond the migration; say so), `README.md` (Email screen paragraph)

**Interfaces:**
- Consumes: everything above; the e2e fake Graph (Task 3; `start-server.sh` exports `E2E_FAKE_GRAPH=1`).

- [ ] **Step 1: Update the existing specs**

`email.spec.ts`: the sub line `lead mail only`. The `Website enquiry` row has no `Unlinked` chip, and it is not listed under a removed `Unlinked` folder: open it from Inbox and use `Link to lead ▾` → `Create lead from this email…` in the second test. Use `Create task` instead of `Add follow-up task`. Assert `Re: Orbit proposal` in the conversation (both messages, newest first) instead of the side panel's thread history, the `orbit-notes.pdf` card with Download, and the Lead panel's company. Folder link names are now `Sent items`. The team part stays (Mail of → Neha, view only, disabled Reply). `emailFit.spec.ts`: rows are `.mrow` (the count of 60 is unchanged). `emailHtml.spec.ts`: the Email screen frame's sandbox is `allow-same-origin allow-popups allow-popups-to-escape-sandbox`, and its height is at least the content's `scrollHeight` (no inner scrollbar). `parity/mail.spec.ts`: use `New mail` instead of `+ Compose`, and open `Website enquiry` from Inbox.

- [ ] **Step 2: Write `emailActions.spec.ts`**

```ts
test('two-way actions: flag, archive with E, move back, multi-select delete, right-click menu, attachment download', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  // Flag ▾ Tomorrow → the row shows the flag; Flagged folder lists it
  // E archives the open message (Archive count / list); Move to ▾ Inbox brings it back
  // right-click a row → menu with Move to ›; Esc closes
  // check two rows → bulk Delete → both in Deleted items; Delete in Deleted items asks to delete permanently (cancel)
  // Download on orbit-notes.pdf answers 200 application/octet-stream; Preview answers inline application/pdf
});
test('typing in the search box never triggers shortcuts', ...
```

- [ ] **Step 3: Run the e2e specs**

Run: `npm run build && npm test -w apps/web -- e2e/email.spec.ts e2e/emailActions.spec.ts e2e/emailFit.spec.ts e2e/emailHtml.spec.ts e2e/parity/mail.spec.ts e2e/projects.spec.ts`
Expected: PASS.

- [ ] **Step 4: Docs**

`docs/PENDING.md` "Ready, waiting for deploy": web-mail release 2. Say what changes for users (the new Email screen; Delete/Archive/Move/Flag/Read change Outlook too; Reply all and Forward; the attachments preview and download; Unlinked is gone). List the calls flagged to the owner (the items in the hand-over list below). Also note: deploy = migration 27 only, no one-time step. `docs/DEPLOYMENT.md`: one line under release notes. `README.md`: the Email screen paragraph.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e docs README.md
git commit -m "test(e2e): web-mail release 2 flows; docs: release 2 pending notes"
```

---

### Task 18: Parity screenshots and full suite

**Files:**
- Create: `apps/web/e2e/parity/webMail.spec.ts`
- Output (not committed): `~/Documents/DAIT-CRM/parity-screenshots-web-mail/release-2/`

**Interfaces:**
- Consumes: the built screen; the mockup HTML; `PATCH /api/me/preferences { language }`.

- [ ] **Step 1: Write the capture spec**

`webMail.spec.ts` (skipped unless `PARITY_WEB_MAIL=1`, so the normal suite does not run it). In `beforeAll` it inserts through `psql`, as `parity/mail.spec.ts` does, mockup-like lead mail for Neha. All rows carry `graph_id` values starting `parity-`, and `afterAll` deletes them. The data: about 8 conversations over Today, Yesterday and Last week, one HTML message with two attachments (PDF and XLSX) in a conversation of three, flags, unread rows, and a second mailbox's lead mail for team view. For each language `en`, `es`, `fr` (set through `/api/me/preferences`) and each viewport `1440×900` and `1280×800`:
  - state 1: Neha, Inbox, the HTML conversation open → `state1-<w>-<lang>-app.png`;
  - state 4: right-click the second row, hover `Move to` → `state4-<w>-<lang>-app.png`;
  - state 5: Maya (Administrator), `Mail of: Everyone`, another mailbox's message open (view only) → `state5-<w>-<lang>-app.png`.
  For the mockup side, it opens `docs/superpowers/mockups/2026-11-26-outlook-mail.html#s=<n>` from disk at the same two viewports → `state<n>-<w>-mockup.png` (English only; the mockup has no translations).

- [ ] **Step 2: Capture**

Run: `npm run build && PARITY_WEB_MAIL=1 PARITY_DIR=$HOME/Documents/DAIT-CRM/parity-screenshots-web-mail/release-2 npm test -w apps/web -- e2e/parity/webMail.spec.ts`
Expected: PASS. The folder holds 18 app images and 6 mockup images.

- [ ] **Step 3: Compare side by side** (open each pair and compare section by section: top bar, command bar, folder pane, list rows, reading pane, lead panel, menu). Fix any difference in layout, controls, wording or order, and capture again. Translated labels must fit at 1280 without breaking the command bar (overflow and icon-only take over). List the remaining deliberate differences, with their reason, in the hand-over (see the self-review list).

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm test && npm run build && npm test -w apps/web`
Expected: all green (shared, api, web unit, deploy test, e2e). Then `git status` shows only the spec file to add.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/parity/webMail.spec.ts
git commit -m "test(parity): web-mail release 2 screenshots of mockup states 1, 4 and 5 in en, es and fr at 1440 and 1280"
```

---

## Self-review

- **Spec coverage:**
  - Top bar, search and Filters panel (From, To, Subject, Lead, Owner, Date, Has attachments), Sync now → T7 (API) + T12.
  - Command bar: New mail ▾ with real templates and Manage templates…, Delete, Archive, Move to ▾, Reply, Reply all, Forward, Flag ▾ (seven items), Mark as unread, the CRM commands, the overflow and icon-only labels → T5/T6/T10 (API) + T11 (fit) + T14.
  - Folder pane (Mail of, seven folders, Leads group with Awaiting reply / Follow-up due today / My or Team leads, footer note) → T7 + T12. Unlinked removed → T7/T12.
  - Message list (chips, conversation view on, sort menu, date groups, row anatomy, lead chip, owner in team view, hover actions, multi-select bulk, right-click menu of state 4, infinite scroll) → T7 + T13.
  - Reading pane (newest on top, expand/collapse, per-message actions, attachment cards with Preview/Download through the server, auto-height HTML in the sandbox) → T8/T9 + T15.
  - Lead panel (fields, actions, recent, folded below 1400 px) → T8 + T16.
  - Keyboard shortcuts → T14.
  - Two-way delete/archive/move/flag/read on the owner's mailbox, optimistic UI, toast on refusal, view-only 403 → T3/T5 + T11/T13/T14.
  - Outlook-side changes (flags) on the next sync → T4.
  - Reply all / Forward through the send path → T6 + T15.
  - Parity screenshots and the full suite → T18.
- **Types:** `MailChange`, `MailBulk`, `MailFollowUp`, `FLAG_PRESETS`, `flagDueDay`, `followUpChoices`, `localNow` (T2) are used by T5, T10, T13 and T14. `GraphFlag`, `GraphAttachment`, `listAttachments`, `attachmentContent`, `setFlag`, `deleteMessage`, `replyAll`, `forward` (T3) are used by T4, T5, T6 and T9. `ChangedMessage` and `MailChangeError` (T5) are used by T11. `orderCandidates`, `listWhere` and `VIEWS` (T7) match `MAIL_VIEWS` (T11). `LeadPanel` (T8) is used by T16. `CommandId`, `MailTarget` and `useMailCommands` (T13) are used by T14, T15 and T16. `replyStart` (T11) is used by T13 and T15.
- **Review Focus:** its five lines are tested in T5 (and T11 on screen), T9, T7, T14 and T2.
- **Deliberate differences from the mockup / calls to flag to the owner at hand-over:**
  - No Pin, Save as .eml or Email settings in "…". Pin is a spec non-goal, and the other two are not in the spec.
  - No React (smile) button: Graph v1.0 has no reactions API.
  - The View tab holds the view toggles.
  - Link to lead is disabled in team view (spec over mockup).
  - The lead panel's Value comes from the lead's newest sent quotation (leads have no value field).
  - Sort by Size is approximate (Graph delta cannot return the message size).
  - The Email-screen frame gains `allow-same-origin` for auto-height (scripts are still blocked).
  - The filters' Owner is the lead owner.
  - Scheduled lists the CRM outbox until release 3.
  - Delete in Deleted items deletes permanently after a confirmation.
  - The "Show mail for" row and the folder-pane template list leave the screen: their links still work, and templates move to New mail ▾.
  - A "This week" date group is added between Yesterday and Last week.
  - Preview covers PDF and pictures only; other files are downloads.
