# Web mail release 3 (writing and follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Writing mail on the Email screen works like Microsoft 365 web mail (mockup states 2, 3, 6 and the Undo toast): an inline Reply / Reply all / Forward editor at the top of the conversation, a full-page New message with its own route, drafts that auto-save to Outlook Drafts, a per-user signature, Schedule send, Undo send, and the "Set the next follow-up" box after Send that adds a task (with priority and note) and the lead's next follow-up. The lead page's Email tab sends through the same path.

**Architecture:** Every message being written is an **Outlook draft** in the sender's own mailbox, mirrored by one CRM `email_messages` row (`source 'crm'`, `status 'draft'`, folder `drafts`, `graph_id` = the draft's immutable id). A new message is `POST /me/messages`; a reply, reply all or forward is `createReply` / `createReplyAll` / `createForward` on the original, so it threads in Outlook and a forward carries the original's attachments. The editor saves by PATCHing the draft; attachments and inline pictures go straight onto the draft (nothing is kept on CRM disk). **Send** queues the existing `send_user_email` job with `runAt` = now + 10 s (Undo window) or the scheduled instant; the job does `POST /messages/{draft}/send`. Undo, Cancel and Edit delete the still-queued job atomically, which returns the row to Drafts. The lead effects (the "Email sent" line, New/Not Contacted → Contacted, the follow-up task, the lead's next follow-up) are applied by the worker **when the mail actually leaves**, so Undo has nothing to reverse. On the web, one `useSendFlow` hook (follow-up box → schedule → undo toast) serves the inline editor, the full page and the lead page.

**Tech Stack:** Fastify 5, Prisma 6 / Postgres, Microsoft Graph v1.0 (delegated Mail.ReadWrite + Mail.Send, already consented), vitest, React 18 + Vite + TanStack Query 5, React Router 6, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-web-mail-email-design.md` (release 3 = "Writing", "Follow-up after Send (state 6)", "Settled" 5, 6, 7, and Goals 4–6 not yet built: Bcc, formatting, signature, Schedule send, Undo send, Send → follow-up). The mockup is the spec for the screen: `docs/superpowers/mockups/2026-11-26-outlook-mail.html` — state 2 (inline reply: `replyEditor()` and `toolbar()`, script lines 1336–1356; CSS `.reply`/`.rtop`/`.fld`/`.rcp`/`.tbar`/`.rbody`/`.sig`/`.quoted*`/`.att-chip*`, lines 545–584), state 3 (full page: markup lines 866–916; CSS `.cpage`/`.cp-*`/`.leadpick`/`.tplbar`/`.schedpop`, lines 586–618 and 727–740), state 6 (`openFollowUp()`, lines 1455–1478; CSS `.modal.fu`/`.fu-*`/`.radio-card`, lines 168–173 and 743–759), Undo toast (`.utoast`, lines 642–650; `sendToast()`, lines 1446–1454), `.sent-note` (line 720). Screenshots: `~/Documents/DAIT-CRM/mockup-screens-outlook-mail/2-reply-inline-1440.png`, `2b-reply-send-followup-modal-1440.png`, `2c-reply-sent-undo-1440.png`, `3-new-message-1440.png`, `3-new-message-1280.png`, `6-followup-after-send-1440.png`, `6b-followup-confirmed-undo-1440.png`. Builds on release 2 (`docs/superpowers/plans/2026-11-27-web-mail-release-2.md`, live as `70ec558`).

## Global Constraints

- Release 3 only, the last web-mail release. Out of scope (spec non-goals): Junk, rules, the user's own folders, Focused/Other, categories, Pin, Outlook Snooze, shared mailboxes, reactions.
- **Styling (as release 2):** live CRM theme only — the tokens in `apps/web/src/styles/app.css`, Montserrat, the existing `.btn`, `.badge`, `.in`, `.chip`, `Modal` components. No dark mode. New CSS lives under the `.wm` root class (the follow-up dialog and the Undo toast, which also show on the lead page, under `.wm-send`). Icons are copied from the mockup's `P` icon map into `apps/web/src/components/Icons.tsx` (`popout`, `pen`, `marker`, `bullets`, `numbers`, `indent`, `outdent`, `image` are new; `send`, `clip`, `template`, `clock`, `x`, `check`, `down`, `link` exist). The message body inside the editor uses the mockup's mail font (`Aptos, Calibri, "Segoe UI", Arial, sans-serif`, 14px), as web mail does.
- **en/es/fr** for every UI string (`npm run i18n:check` is part of `npm run typecheck`). Dates and times are 24-hour in the viewer's time zone (`me.timezone`); "Draft saved hh:mm", schedule and follow-up choices included.
- **Sending only from your own mailbox.** Every draft, send, undo, schedule and attachment route acts only on the caller's own connected personal mailbox (`kind 'personal'`, `status 'connected'`, `userId` = caller). Another user's message or draft (team view) answers `403 { error: 'view_only' }` (server-enforced through `messageFor(…, 'change')` in `apps/api/src/mail/access.ts`); a message the caller may not see at all answers 404. On screen the controls stay disabled with `View only — {name}'s mailbox` (release 2's `useMailCommands`).
- **No new Microsoft permission.** Only Mail.ReadWrite and Mail.Send are used (`GRAPH_MAIL_SCOPES` in `apps/api/src/graph/client.ts`). Graph deferred send (`PidTagDeferredSendTime`) is **not** used; Schedule send and Undo send run on the CRM job queue (see "Decisions I made" 1).
- **HTML safety:** everything sent is sanitised by the existing outgoing sanitiser (`outgoingBody` / `sanitizeFormatted` in `apps/api/src/mail/formatted.ts`, cap `FORMATTED_HTML_MAX = 200_000`) in the worker thread, with `cid:` pictures kept only for the draft's own inline pictures. Everything shown (the quoted text, a draft opened from Outlook) is shown in a sandboxed frame without `allow-scripts` (`MessageEditor`'s frame, or `MailBody`). The editor reuses `apps/web/src/components/MessageEditor.tsx` (sandboxed, same-origin, no scripts, paste cleaned by `cleanPastedHtml`, links through `safeLinkUrl`).
- **Files:** a draft attachment or inline picture is one file of at most `TEMPLATE_ATTACHMENTS_MAX_BYTES` (2 500 000 bytes), of a type `sniff()` (`apps/api/src/mail/files.ts`) recognises from its bytes (PDF, PNG, JPEG, GIF, docx, xlsx, pptx, doc, xls), at most 20 per draft; it is uploaded straight to the Outlook draft and never stored by the CRM. Refusals: `413 attachments_too_large`, `422 attachment_type`, `422 attachment_invalid`.
- **Undo window:** `UNDO_SEND_SECONDS = 10`. The toast text is exactly `Sent · follow-up added for {when}` (with a follow-up) or `Sent` (without), followed by the `Undo` button, with a 10-second progress bar (mockup `.utoast`).
- **Follow-up box values (spec, verbatim):** choices `Tomorrow 09:00`, `In 3 working days 09:00` (default, badge `Default`), `In 1 week`, `In 2 weeks` (09:00), `Choose date and time`; working days skip Saturday and Sunday only; task title `Follow up: <subject>` (editable); Assigned to (default me; others only with `view_all_leads`, as `TaskModal`); Type `Email` → `followup`, `Call` → `call`, `Meeting` → `meeting`; Priority `Normal` / `High`; Note (optional, at most 1000 characters); `Also update the lead's next follow-up` (ticked); buttons `Send and add follow-up` (primary), `Send without follow-up`, `Cancel`. Task origin `email_follow_up`. The lead's next follow-up stays a date; the time is the task's `dueTime`.
- **Schedule send presets:** `Later today` 17:00 (offered only before 17:00, as release 2's Follow-up ▾), `Tomorrow morning` 08:00, `Monday morning` 08:00 (the next Monday; a week on when today is Monday), custom date + 24-hour time; the instant must be at least 1 minute ahead and at most 365 days ahead (`400 schedule_time`).
- No new npm dependency. Tokens and secrets stay on the server.
- Every command runs from `~/Documents/DAIT-CRM/CRM-DAIT`. Full test command: `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London caffeinate -i npm test`. Single files: prefix the same `PATH=… TZ=Europe/London`. Unit DB `dait_crm_unit`, e2e DB `dait_crm_e2e`. After changing `packages/shared`, run `npm run build -w packages/shared` before the api/web tests.
- Commits go on branch `web-mail-r3`. Never commit `Reference/` or unrelated `package-lock.json` drift (`git add` named paths only). Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GKS9Jmtrg6EmfFh6J9p9ci`.
  Deploy only on the owner's "deploy", database backup first.

## Review Focus

1. **Undo racing the worker.** The user clicks Undo at 9.9 s while the worker claims the job. Exactly one outcome: the mail never leaves and is back in Drafts with no task and no "Email sent" line, **or** the answer is `409 already_sent` and the toast says `Too late: the email was sent.` Never both. Test in Task 8.
2. **Restarts and interrupted sends.** A worker or API restart during the 10 s window or before a scheduled time still sends the mail once, at or after its time. A send interrupted after the claim (row left `sending`) is never sent again: it is marked Failed, put back in Drafts, and the sender gets a notification. Test in Task 8.
3. **The draft changed in Outlook.** A draft deleted, or sent, in Outlook while the CRM holds it: an auto-save that meets Graph 404 answers `409 draft_gone` and the editor says so (with `Save as a new draft`); a scheduled send that meets 404 is Failed `draft_gone`, back in Drafts, notified, never retried. Tests in Tasks 6 and 8.
4. **Sync duplicates.** The CRM's own draft read back from Outlook Drafts by the 5-minute sync must not become a second row or change folder while queued; the Sent Items copy after the send must claim the CRM row (one row in Sent, not two). Test in Task 8.
5. **Days and time zones.** An Asia/Kolkata user at 23:30 UTC (already tomorrow for them), a Friday "In 3 working days" (→ Wednesday), "Monday morning" on a Monday (→ next Monday), a Europe/London 08:00 across the DST change, and a custom time in the past (refused). The days are the user's local days and the instants are right. Tests in Tasks 2 and 8.

---

### Task 1: Schema for drafts, signature and task fields

**Files:**
- Modify: `prisma/schema.prisma` (`User`, `Task`, `EmailMessage`)
- Create: `prisma/migrations/20261214100000_web_mail_writing/migration.sql` (generated)
- Modify: `docs/MIGRATIONS.md` (row 28), `docs/data-model.md`
- Test: `apps/api/test/db.test.ts`

**Interfaces:**
- Produces:
  - `User.signatureHtml: string | null` (`signature_html TEXT`), `User.signatureAuto: boolean` (`signature_auto BOOLEAN NOT NULL DEFAULT true`).
  - `Task.priority: string` (`priority VARCHAR(6) NOT NULL DEFAULT 'normal'`; `normal | high`), `Task.note: string | null` (`note TEXT`).
  - `EmailMessage.scheduledAt: Date | null` (`scheduled_at TIMESTAMP(3)`; set only for a scheduled send), `EmailMessage.quotedHtml: string | null` (`quoted_html TEXT`; the folded quote of a reply/forward draft, sanitised), `EmailMessage.draftFiles: Json` (`draft_files JSONB NOT NULL DEFAULT '[]'`; `DraftFile[]` of Task 7). Model comments name "web-mail release 3".
  - `EmailMessage.status` comment gains: a CRM draft is `'draft'`; a draft being sent is `'queued'` / `'sending'` while still in folder `drafts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/db.test.ts
it('web-mail release 3 columns: user signature, task priority and note, message schedule/quote/files', async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(u).toMatchObject({ signatureHtml: null, signatureAuto: true });
  const t = await prisma.task.create({ data: { title: 'x', dueDate: new Date('2026-12-01'), assignedToId: user.id, origin: 'manual' } });
  expect(t).toMatchObject({ priority: 'normal', note: null });
  const m = await prisma.emailMessage.create({ data: { userId: user.id, folder: 'drafts', status: 'draft', fromAddress: 'a@b.co', subject: 's' } });
  expect(m).toMatchObject({ scheduledAt: null, quotedHtml: null, draftFiles: [] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/api -- test/db.test.ts`
Expected: FAIL (unknown field `signatureHtml`).

- [ ] **Step 3: Change the schema and generate the migration**

Run `npm run db:migrate -w apps/api -- --name web_mail_writing`, rename the folder to `20261214100000_web_mail_writing`, and check the SQL only adds nullable or defaulted columns.

- [ ] **Step 4: Run the test**

Run: `npm test -w apps/api -- test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Document and commit**

`docs/MIGRATIONS.md` row 28: `20261214100000_web_mail_writing` | `users.signature_html`, `users.signature_auto` (default true); `tasks.priority` (default `normal`), `tasks.note`; `email_messages.scheduled_at`, `quoted_html`, `draft_files` (default `[]`) | Web mail release 3 (not yet released). Add the columns to `docs/data-model.md`.

```bash
git add prisma docs/MIGRATIONS.md docs/data-model.md apps/api/test/db.test.ts
git commit -m "feat(mail): columns for drafts, scheduled send, signature and task priority/note"
```

---

### Task 2: Shared schemas and date presets

**Files:**
- Modify: `packages/shared/src/mailDates.ts`, `packages/shared/src/schemas/email.ts`, `packages/shared/src/schemas/task.ts`, `packages/shared/src/leads.ts`
- Test: `packages/shared/test/mailDates.test.ts`, `packages/shared/test/mailSchemas.test.ts`, `packages/shared/test/schemas.test.ts` (task cases)

**Interfaces:**
- Produces (`leads.ts`): `TASK_ORIGINS` gains `'email_follow_up'`; `export const TASK_PRIORITIES = ['normal', 'high'] as const; export type TaskPriority`.
- Produces (`schemas/task.ts`): `TaskCreate` and `TaskUpdate` gain `priority: z.enum(TASK_PRIORITIES)` (`.default('normal')` on create, optional on update) and `note: z.string().trim().max(1000).nullable().optional()` (empty string → null).
- Produces (`mailDates.ts`; days are `YYYY-MM-DD` in the user's zone):
  - `export function addWorkingDays(day: string, n: number): string` (skips Saturday and Sunday only)
  - `export type SendFollowUpKey = 'tomorrow' | 'threeWorkingDays' | 'oneWeek' | 'twoWeeks'; export const DEFAULT_SEND_FOLLOW_UP: SendFollowUpKey = 'threeWorkingDays'`
  - `export function sendFollowUpChoices(baseDay: string): { key: SendFollowUpKey; date: string; time: string }[]` — tomorrow = +1 day, threeWorkingDays = `addWorkingDays(baseDay, 3)`, oneWeek = +7, twoWeeks = +14; all `09:00`.
  - `export type ScheduleKey = 'laterToday' | 'tomorrow' | 'monday'`
  - `export function schedulePresets(today: string, nowTime: string): { key: ScheduleKey; date: string; time: string }[]` — laterToday `17:00` only when `nowTime < '17:00'`; tomorrow `08:00`; monday = the next Monday `08:00`.
  - `export function instantIn(day: string, time: string, timezone: string): Date` — the UTC instant of that wall-clock time (UTC for an unknown zone); a wall time that does not exist (spring-forward gap) moves forward by the gap. Same two-pass offset method as `startOfDayIn` in `apps/api/src/leads/dates.ts`.
- Produces (`schemas/email.ts`; `mailAddress` is the existing local schema, `isoDate` from `./common.js`):
  - `export const UNDO_SEND_SECONDS = 10; export const DRAFT_KINDS = ['new', 'reply', 'replyAll', 'forward'] as const; export type DraftKind`
  - `export const DraftCreate = z.object({ kind: z.enum(DRAFT_KINDS).default('new'), replyToId: z.number().int().positive().optional(), leadId: z.number().int().positive().optional(), projectId: z.number().int().positive().optional() })`, refined: `reply`/`replyAll`/`forward` need `replyToId` (path `['replyToId']`); `new` refuses it.
  - `const recipientList = z.array(mailAddress).max(50).default([])`
  - `export const DraftSave = z.object({ to: recipientList, cc: recipientList, bcc: recipientList, subject: z.string().max(500).default(''), bodyHtml: z.string().max(1_000_000), leadId: z.number().int().positive().nullable().optional(), projectId: z.number().int().positive().nullable().optional() })`
  - `export const SendFollowUp = z.object({ date: isoDate, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), title: z.string().trim().min(1).max(200), assignedToId: z.number().int().positive(), kind: z.enum(TASK_KINDS), priority: z.enum(TASK_PRIORITIES).default('normal'), note: z.string().trim().max(1000).optional(), updateLead: z.boolean().default(true) })`
  - `export const DraftSend = DraftSave.extend({ at: z.string().datetime().nullable().default(null), followUp: SendFollowUp.nullable().default(null) })`
  - `export const DraftAttachmentUpload = TemplateAttachmentUpload.pick({ name: true, data: true }).extend({ inline: z.boolean().default(false) })`
  - `export const DraftTemplateApply = z.object({ templateId: z.number().int().positive(), attachmentIds: z.array(z.number().int().positive()).max(TEMPLATE_ATTACHMENTS_MAX_COUNT).default([]) })`
  - `export const SIGNATURE_HTML_MAX = 20_000; export const SignatureUpdate = z.object({ html: z.string().max(200_000).nullable(), auto: z.boolean() })`
  - `export const RecipientQuery = z.object({ q: z.string().trim().min(1).max(100) })`; `export const RecipientResolve = z.object({ addresses: z.array(mailAddress).max(150) })`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/mailDates.test.ts
test('send follow-up choices from Thu 26 Nov 2026 (mockup state 6)', () => {
  expect(sendFollowUpChoices('2026-11-26')).toEqual([
    { key: 'tomorrow', date: '2026-11-27', time: '09:00' }, { key: 'threeWorkingDays', date: '2026-12-01', time: '09:00' },
    { key: 'oneWeek', date: '2026-12-03', time: '09:00' }, { key: 'twoWeeks', date: '2026-12-10', time: '09:00' },
  ]);
});
test('3 working days from Friday is Wednesday, from Saturday is Wednesday (Review Focus 5)', () => {
  expect(addWorkingDays('2026-11-27', 3)).toBe('2026-12-02');
  expect(addWorkingDays('2026-11-28', 3)).toBe('2026-12-02');
});
test('schedule presets at 14:30 on Thu 26 Nov (mockup), none "later today" from 17:00, Monday on a Monday is next week (Review Focus 5)', () => {
  expect(schedulePresets('2026-11-26', '14:30')).toEqual([
    { key: 'laterToday', date: '2026-11-26', time: '17:00' }, { key: 'tomorrow', date: '2026-11-27', time: '08:00' },
    { key: 'monday', date: '2026-11-30', time: '08:00' },
  ]);
  expect(schedulePresets('2026-11-26', '17:00').map((p) => p.key)).toEqual(['tomorrow', 'monday']);
  expect(schedulePresets('2026-11-30', '09:00').find((p) => p.key === 'monday')!.date).toBe('2026-12-07');
});
test('instantIn: Kolkata 09:00, London 08:00 either side of the DST change, a spring-forward gap moves forward (Review Focus 5)', () => {
  expect(instantIn('2026-12-01', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-12-01T03:30:00.000Z');
  expect(instantIn('2027-03-27', '08:00', 'Europe/London').toISOString()).toBe('2027-03-27T08:00:00.000Z');
  expect(instantIn('2027-03-29', '08:00', 'Europe/London').toISOString()).toBe('2027-03-29T07:00:00.000Z');
  expect(instantIn('2027-03-28', '01:30', 'Europe/London').toISOString()).toBe('2027-03-28T01:30:00.000Z');
});
// packages/shared/test/mailSchemas.test.ts
test('DraftCreate: replies need replyToId, new refuses it', () => {
  expect(DraftCreate.safeParse({ kind: 'replyAll' }).success).toBe(false);
  expect(DraftCreate.safeParse({ kind: 'new', replyToId: 4 }).success).toBe(false);
  expect(DraftCreate.parse({}).kind).toBe('new');
});
test('DraftSend: at defaults to null; follow-up needs a 24-hour time and a title; note at most 1000', () => {
  const base = { bodyHtml: '<p>x</p>' };
  expect(DraftSend.parse(base)).toMatchObject({ at: null, followUp: null, to: [], bcc: [] });
  const fu = { date: '2026-12-01', time: '09:00', title: 'Follow up: x', assignedToId: 1, kind: 'followup' };
  expect(DraftSend.parse({ ...base, followUp: fu }).followUp).toMatchObject({ priority: 'normal', updateLead: true });
  expect(DraftSend.safeParse({ ...base, followUp: { ...fu, time: '24:00' } }).success).toBe(false);
  expect(DraftSend.safeParse({ ...base, followUp: { ...fu, note: 'n'.repeat(1001) } }).success).toBe(false);
});
// packages/shared/test/schemas.test.ts
test('tasks take priority (default normal) and a note; email_follow_up is an origin', () => {
  expect(TaskCreate.parse({ title: 't', dueDate: '2026-12-01', assignedToId: 1 }).priority).toBe('normal');
  expect(TaskUpdate.safeParse({ priority: 'urgent', updatedAt: new Date().toISOString() }).success).toBe(false);
  expect(TASK_ORIGINS).toContain('email_follow_up');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w packages/shared -- test/mailDates.test.ts test/mailSchemas.test.ts test/schemas.test.ts`
Expected: FAIL (exports not found).

- [ ] **Step 3: Implement** the functions and schemas with the signatures above (export them from `packages/shared/src/index.ts` if not re-exported already).

- [ ] **Step 4: Run to verify they pass**

Run: `npm run build -w packages/shared && npm test -w packages/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): draft, send, follow-up, signature and recipient schemas; working-day, schedule and zoned-instant helpers; task priority and note"
```

---

### Task 3: Graph client — drafts, draft attachments, sending a draft; fakes

**Files:**
- Modify: `apps/api/src/graph/client.ts`, `apps/api/src/graph/e2eFake.ts`
- Modify: `apps/api/test/helpers.ts` (`fakeGraph`), `apps/api/test/e2e-send-jobs.ts`, `apps/api/test/e2e-import-jobs.ts`, `apps/api/test/e2e-research-jobs.ts` and any other `GraphClient` literal `npm run typecheck` reports
- Test: `apps/api/test/graphClient.test.ts`, `apps/api/test/e2eGraph.test.ts`

**Interfaces:**
- Produces (`client.ts`):
  - `export interface DraftFields { subject: string; html: string; to: string[]; cc: string[]; bcc: string[]; from?: string | null }`
  - `export interface GraphDraft { id: string; conversationId: string | null; subject: string; html: string; to: string[]; cc: string[]; bcc: string[]; lastModified: string; attachments: GraphAttachment[] }` (addresses lower-cased; `html` from `body.content` with `Prefer: outlook.body-content-type="html"`)
  - `GraphClient` gains, all through `mailCall` (immutable ids, `GRAPH_MAIL_SCOPES`):
    - `createDraft(account, d: DraftFields): Promise<GraphDraft>` — `POST /me/messages` with `subject`, `body { contentType: 'HTML', content }`, `toRecipients`, `ccRecipients`, `bccRecipients`, and `from` only when `d.from` is set.
    - `createReplyDraft(account, graphId: string, kind: 'reply' | 'replyAll' | 'forward'): Promise<GraphDraft>` — `POST …/createReply` / `createReplyAll` / `createForward` with an empty body.
    - `getDraft(account, draftId): Promise<GraphDraft>` — `GET` with `$select=subject,body,toRecipients,ccRecipients,bccRecipients,conversationId,lastModifiedDateTime,isDraft&$expand=attachments($select=id,name,contentType,size,isInline)`; a message whose `isDraft` is false → `GraphError('not_a_draft', 409)`.
    - `updateDraft(account, draftId, d: DraftFields): Promise<void>` — `PATCH` the same fields.
    - `addAttachment(account, draftId, a: MailAttachment): Promise<{ id: string }>` — `POST …/attachments` (`#microsoft.graph.fileAttachment`, `isInline` + `contentId` for inline).
    - `removeAttachment(account, draftId, attachmentId: string): Promise<void>` — `DELETE …/attachments/{encodeURIComponent(id)}`.
    - `sendDraft(account, draftId): Promise<void>` — `POST …/send`, timeout `SEND_TIMEOUT_MS`.
  - `e2eFake.ts`: holds drafts in a module `Map<string, GraphDraft>` (ids `e2e-draft-<n>`, `conversationId` of the original for replies); `createDraft`, `createReplyDraft` (quote body `<div id="divRplyFwdMsg"><b>From:</b> …</div>` for `e2e-2`), `getDraft`, `updateDraft`, `addAttachment` (ids `e2e-att-<n>`), `removeAttachment`, `deleteMessage` work on it; `sendDraft` rejects `Error('not used in e2e')` (the e2e server runs no worker).
  - `e2e-send-jobs.ts`: before running, sets `run_at = now()` on queued `send_user_email` jobs (the undo window); its fake `sendDraft` prints `e2e-sent: {json}` with the CRM row found by `graph_id` (to, cc, bcc, subject, html, `draftFiles` names/inline/content-id/size).

- [ ] **Step 1: Write the failing tests**

```ts
// graphClient.test.ts (stubbed fetch, as the existing cases)
test('createDraft posts subject, HTML body and To/Cc/Bcc with immutable ids, and maps the answer', async () => {
  expect(call.url).toBe('https://graph.microsoft.com/v1.0/me/messages');
  expect(call.headers.Prefer).toContain('IdType="ImmutableId"');
  expect(call.body).toEqual({ subject: 'Proposal', body: { contentType: 'HTML', content: '<p>Hi</p>' }, toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }], ccRecipients: [], bccRecipients: [{ emailAddress: { address: 'b@acme.com' } }] });
  expect(draft).toMatchObject({ id: 'AAMkD=', conversationId: 'CONV1', to: ['ana@acme.com'] });
});
test('createReplyDraft calls createReply / createReplyAll / createForward on the original', ...
test('createDraft sends from only when a send-as address is given', ...
test('getDraft refuses a message that is no longer a draft with 409 not_a_draft', ...
test('updateDraft PATCHes the fields; addAttachment posts a fileAttachment (inline with contentId); removeAttachment DELETEs it', ...
test('sendDraft posts /send with the send timeout', ...
// e2eGraph.test.ts
test('the e2e fake keeps drafts: create, update, attach, get, delete', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/graphClient.test.ts test/e2eGraph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the methods, the fakes (`unexpected(...)` for each new method in `fakeGraph`) and the e2e helpers.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/graphClient.test.ts test/e2eGraph.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/graph apps/api/test
git commit -m "feat(graph): drafts (new, reply, reply all, forward), draft attachments and sending a draft; fakes"
```

---

### Task 4: Tasks — priority, note and the email follow-up task

**Files:**
- Modify: `apps/api/src/leads/service.ts` (`syncFollowUpTask`, new `openFollowUpTask`), `apps/api/src/routes/tasks.ts` (create/update, `editableTask`), `apps/api/src/leads/serialize.ts` (`taskRow`), `apps/api/src/mail/leadPanel.ts`, `apps/api/src/mail/crm.ts` (`setLeadFollowUp`)
- Modify: `apps/web/src/api/tasks.ts` (types), `apps/web/src/pages/tasks/TasksList.tsx`, `apps/web/src/pages/tasks/TaskModal.tsx`, `apps/web/src/i18n/labels.ts` (origin label `Email follow-up`), `apps/web/src/styles/app.css`, locales
- Test: `apps/api/test/tasks.test.ts`, `apps/api/test/mailReading.test.ts`, `apps/api/test/mailCrm.test.ts`, `apps/web/test/taskKind.test.tsx`

**Interfaces:**
- Consumes: Task 1 columns; Task 2 `TASK_PRIORITIES`, `TaskCreate`/`TaskUpdate` fields, origin `email_follow_up`.
- Produces:
  - `export async function openFollowUpTask(db: Tx | PrismaClient, lead: Pick<Lead, 'id' | 'nextFollowUp'>): Promise<Task | null>` — the lead's open follow-up task: the open `follow_up` task, else the open `email_follow_up` task whose `dueDate` equals `lead.nextFollowUp` (earliest id).
  - `syncFollowUpTask(tx, lead)`: when an open `email_follow_up` task's `dueDate` equals `lead.nextFollowUp`, it **stands in** for the lead follow-up: no `follow_up` task is created and open `follow_up` tasks are removed. Otherwise unchanged.
  - `editableTask` returns `followUpLead` for an `email_follow_up` task that stands in (same day as the lead's next follow-up), so ticking it done or moving its date mirrors onto `lead.nextFollowUp` as for `follow_up`.
  - `taskRow` adds `priority: 'normal' | 'high'`, `note: string | null`. `POST /tasks` and `PATCH /tasks/:id` store them (audited).
  - `leadPanel(...).followUp` and `setLeadFollowUp` use `openFollowUpTask` (so a standing-in email task gives the date and time).
  - Web: a task row shows a small `.badge` `High` after the title when `priority === 'high'`, and `note` as a second muted line (`.task-note`, one line, ellipsis, full text in `title`). `TaskModal` gains `Priority` (`Normal` / `High`) and `Note` (textarea, optional, 1000 max). The origin label for `email_follow_up` is `Email follow-up`.

- [ ] **Step 1: Write the failing tests**

```ts
// tasks.test.ts
it('creates and edits a task with priority and note; the list returns them', async () => {
  const res = await call('POST', '/api/tasks', repCookie, { title: 'Call Ana', dueDate: '2026-12-01', assignedToId: rep.id, priority: 'high', note: 'Ask about the CTO' });
  expect(res.json()).toMatchObject({ priority: 'high', note: 'Ask about the CTO' });
});
it('an email follow-up task on the lead follow-up day stands in for it: no second follow_up task; done clears the lead date', async () => {
  // lead.nextFollowUp = 2026-12-01; task { origin: 'email_follow_up', dueDate: 2026-12-01, dueTime: '09:00' }; then syncFollowUpTask
  expect(await prisma.task.count({ where: { leadId: lead.id, isDone: false } })).toBe(1);
  await call('PATCH', `/api/tasks/${task.id}`, repCookie, { isDone: true, updatedAt });
  expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();
});
it('an email follow-up task on another day leaves the lead follow-up task alone', ...
// mailReading.test.ts
it('lead panel follow-up shows the standing-in email follow-up task date and time', ...
  expect(body.leadPanel.followUp).toMatchObject({ date: '2026-12-01', time: '09:00' });
```

```tsx
// taskKind.test.tsx
it('a high-priority task shows the High badge and its note as a second muted line', async () => {
  expect(within(row).getByText('High')).toHaveClass('badge');
  expect(within(row).getByText('Ask about the CTO')).toHaveClass('task-note');
});
it('the task dialog edits priority and note', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build -w packages/shared && npm test -w apps/api -- test/tasks.test.ts test/mailReading.test.ts test/mailCrm.test.ts && npm run test:unit -w apps/web -- test/taskKind.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr for `High`, `Priority`, `Normal`, `Note`, `Email follow-up`.

- [ ] **Step 4: Run to verify they pass**

Run: same as Step 2, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test apps/web/src apps/web/test
git commit -m "feat(tasks): priority and note; email follow-up tasks stand in for the lead follow-up on the same day"
```

---

### Task 5: Signature — API and Settings

**Files:**
- Modify: `apps/api/src/routes/me.ts`
- Create: `apps/web/src/pages/settings/SignatureCard.tsx`
- Modify: `apps/web/src/pages/settings/MySettings.tsx` (renders the card under Preferences), `apps/web/src/api/useCurrentUser.ts` or a new `apps/web/src/api/signature.ts`, locales
- Test: `apps/api/test/users.test.ts` (holds the `/me/preferences` cases), `apps/web/test/signature.test.tsx`

**Interfaces:**
- Consumes: Task 1 `User.signatureHtml`, `signatureAuto`; Task 2 `SignatureUpdate`, `SIGNATURE_HTML_MAX`; `sanitizeFormatted` (`mail/formatted.ts`).
- Produces:
  - `GET /me/signature` → `{ html: string | null; auto: boolean }`. `PUT /me/signature` (body `SignatureUpdate`) → sanitised with `sanitizeFormatted(html, SIGNATURE_HTML_MAX)`: `html` kind → stored; `empty` → null; `fallback` → its text as simple HTML; longer than `SIGNATURE_HTML_MAX` after sanitising → `400 { error: 'signature_too_long' }`. Pictures are dropped (only `http(s)` links and formatting stay: `img` removed before storing). Audited `{ entityType: 'user', action: 'update', after: { signature: true, auto } }` (no content).
  - `export function useSignature(): UseQueryResult<{ html: string | null; auto: boolean }>`; `export function useSaveSignature()`.
  - `SignatureCard`: card `Email signature`, sub line `Added to new emails and replies you write in the CRM.`, a `MessageEditor` (formatted from the start), checkbox `Add automatically` (default on), `Save`; toast `Signature saved`.

- [ ] **Step 1: Write the failing tests**

```ts
it('saves a signature sanitised (no script, no pictures) with Add automatically; reads it back', async () => {
  await call('PUT', '/api/me/signature', repCookie, { html: '<b>Maya</b><script>x()</script><img src="https://x/y.png">', auto: false });
  expect((await call('GET', '/api/me/signature', repCookie)).json()).toEqual({ html: '<b>Maya</b>', auto: false });
});
it('a signature over 20 000 characters is 400 signature_too_long; audit carries no content', ...
```

```tsx
it('Settings: edit the signature, untick Add automatically, Save', async () => {
  await user.click(screen.getByRole('checkbox', { name: 'Add automatically' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(lastBody()).toEqual({ html: expect.stringContaining('Maya'), auto: false });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/users.test.ts && npm run test:unit -w apps/web -- test/signature.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: same as Step 2, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/test apps/web/src apps/web/test/signature.test.tsx
git commit -m "feat(mail): per-user email signature, edited in Settings"
```

---

### Task 6: Drafts API — create, open, save, discard, recipients

**Files:**
- Create: `apps/api/src/mail/drafts.ts`, `apps/api/src/routes/mailDrafts.ts`
- Modify: `apps/api/src/app.ts` (register `mailDraftRoutes` under `/api`; error handler answers `DraftError`)
- Test: `apps/api/test/mailDrafts.test.ts`

**Interfaces:**
- Consumes: Task 2 `DraftCreate`, `DraftSave`, `RecipientQuery`, `RecipientResolve`; Task 3 `createDraft`, `createReplyDraft`, `getDraft`, `updateDraft`, `deleteMessage`; release 2 `replyRecipients`, `replySubject`, `messageFor`, `canSeeLead`, `assertLeadVisible`, `assertProjectFor`, `outlookFailure`, `processEmailBody`; `resolveTimezones` (shared timezones).
- Produces (`mail/drafts.ts`):
  - `export class DraftError extends Error { constructor(readonly code: 'no_mailbox' | 'draft_gone' | 'not_draft' | 'no_recipients' | 'schedule_time' | 'follow_up_time' | 'already_sent', readonly status: 400 | 409) }`
  - `export const QUOTE_MAX = 200_000`
  - `export async function myAccount(userId: number): Promise<EmailAccount>` — the connected personal mailbox, else `DraftError('no_mailbox', 409)`.
  - `export async function createDraft(graph: GraphClient, user: AuthUser, body: DraftCreate): Promise<EmailMessage>` — `new`: `graph.createDraft` with empty fields (body = the signature block when `signatureAuto`, see `signatureBlock`), lead (`assertLeadVisible`) and project (`assertProjectFor`) as given. Replies: `messageFor(…, body.replyToId, 'change')` (403 `view_only` for another user's; 409 `draft` for a draft original), then `graph.createReplyDraft` on the original's `graphId` when it is in the caller's mailbox; recipients and subject from `replyRecipients` / `replySubject` (Cc = original Cc minus own for replyAll), then `updateDraft` so Outlook holds exactly those. `quotedHtml` = the Graph draft body sanitised with `processEmailBody(…, QUOTE_MAX, { outgoing: true })` (its text as simple HTML when larger). An original without a `graphId` (CRM-only) → `graph.createDraft` and `quotedHtml` built from the stored original (`From / Sent / To / Subject` header in the sender's zone, as `withForwarded` in `sendUserEmail.ts` — move that header builder into `drafts.ts` as `quoteHeader(original, timezone)` and use it from both). The row: `source 'crm'`, `status 'draft'`, folder `drafts`, `graphId`, `threadId` (Graph `conversationId`), `replyToId`, `leadId` (the original's when the caller can see it), `companyId`, `contactId`, `projectId`, `fromAddress` = `account.sendAs ?? account.address`, `bodyHtml` = initial user part, `quotedHtml`.
  - `export function signatureBlock(html: string | null): string` — `''` for none, else `<p><br></p><div class="dait-sig">{html}</div>`.
  - `export interface DraftView { id; replyToId: number | null; from: string; to: Recipient[]; cc: Recipient[]; bcc: Recipient[]; subject: string; bodyHtml: string; quotedHtml: string | null; files: DraftFileView[]; leadId: number | null; projectId: number | null; lead: LeadPanel | null; recipientZone: { zone: string; label: string } | null; savedAt: string; status: string; scheduledAt: string | null }` with `type Recipient = { address: string; name: string | null; leadNumber: string | null }`. `lead` = release 2 `leadPanel(...)` for the right-hand summary. `recipientZone` = `resolveTimezones` of the lead's company when it gives one zone different from the sender's (`label` = the zone's city, e.g. `Chicago`).
  - `export async function openDraft(graph: GraphClient, user: AuthUser, m: EmailMessage): Promise<DraftView>` — own draft only (`messageFor 'change'`; status `draft` or `failed` (a failed send, Task 8), else `409 not_draft`; saving a `failed` one makes it `draft` again). A CRM draft is shown from its row; a draft made in Outlook (`source 'sync'`) is read fresh with `getDraft` (whole body editable, `quotedHtml` null) and its row updated. Graph 404 → `DraftError('draft_gone', 409)`.
  - `export async function saveDraft(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftSave): Promise<{ savedAt: string }>` — the user part sanitised with `outgoingBody(undefined, body.bodyHtml, cids)` (`cids` = the draft's inline content-ids, Task 7), then `updateDraft` with `html = userHtml + (quotedHtml ?? '')`, then the row (to, cc, bcc, subject, bodyHtml, bodyText, lead/project re-checked, `updatedAt`). Graph 404 → `draft_gone`; other Graph errors → `outlookFailure`. Never logs subject, body or addresses.
  - `export async function discardDraft(graph, user, m): Promise<void>` — `deleteMessage` (404 ignored), then the row is deleted.
  - `export async function suggestRecipients(user: AuthUser, q: string): Promise<Recipient[]>` — at most 8 contacts and leads with an email the user can see (`leadWhere`), name or address containing `q` (ILIKE escaped), the lead number when on a lead.
  - `export async function resolveRecipients(user: AuthUser, addresses: string[]): Promise<Recipient[]>` — the same shape for known addresses, `name: null, leadNumber: null` otherwise.
- Produces (routes, all `requireRight('use_email')`):
  - `POST /mail/drafts` (body `DraftCreate`, `perUser(30)`) → 201 `DraftView`.
  - `GET /mail/drafts/:id` → `DraftView`.
  - `PATCH /mail/drafts/:id` (body `DraftSave`, `bodyLimit: FORMATTED_BODY_LIMIT`, `perUser(120)`) → `{ savedAt }`.
  - `DELETE /mail/drafts/:id` → 204.
  - `GET /mail/recipients?q=` → `{ items: Recipient[] }`; `POST /mail/recipients/resolve` → `{ items }`.

- [ ] **Step 1: Write the failing tests** (`buildApp({ graph: fakeGraph({...}) })`; rep Maya connected; admin Deepak; a lead LD with contact `ana@acme.com`)

```ts
it('New: creates an Outlook draft and a CRM draft row on the lead, with the signature when Add automatically is on', async () => {
  const res = await call('POST', '/api/mail/drafts', repCookie, { kind: 'new', leadId: lead.id });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ replyToId: null, leadId: lead.id, bodyHtml: '<p><br></p><div class="dait-sig"><b>Maya</b></div>', quotedHtml: null });
  expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } })).toMatchObject({ source: 'crm', status: 'draft', folder: 'drafts', graphId: 'D1' });
});
it('Reply all: createReplyAll on the original, To = sender + other To without mine, Cc = original Cc without mine, subject Re:, quote kept, same thread', ...
  expect(calls).toEqual([['createReplyDraft', original.graphId, 'replyAll'], ['updateDraft', 'D1', expect.objectContaining({ to: ['ana@acme.com', 'bo@acme.com'], cc: ['cy@acme.com'], subject: 'Re: Proposal' })]]);
  expect(body).toMatchObject({ quotedHtml: expect.stringContaining('divRplyFwdMsg') });
it('Forward of a CRM-only original builds the quote from the stored message (From, Sent in the sender zone, To, Subject)', ...
it("a reply draft on another user's message is 403 view_only and Graph is not called (team view)", ...
it("opening, saving or discarding another user's draft is 403 view_only; a Sales rep gets 404", ...
it('save: the user part is sanitised (no script), Outlook gets user part + quote, the row keeps To/Cc/Bcc/subject', async () => {
  await call('PATCH', `/api/mail/drafts/${d.id}`, repCookie, { to: ['ana@acme.com'], bcc: ['b@acme.com'], subject: 'S', bodyHtml: '<p>Hi</p><script>x()</script>' });
  expect(updates.at(-1)![1]).toMatchObject({ html: '<p>Hi</p>' + quote, bcc: ['b@acme.com'] });
});
it('save after the draft was deleted in Outlook is 409 draft_gone (Review Focus 3)', ...
it('a draft made in Outlook opens fresh from Graph, whole body editable', ...
it('discard deletes the Outlook draft (404 tolerated) and the row', ...
it('recipients: suggestions from visible contacts and leads with lead numbers; resolve names known addresses', ...
it('no connected mailbox: 409 no_mailbox', ...
it('nothing about the mail is logged on a Graph refusal', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build -w packages/shared && npm test -w apps/api -- test/mailDrafts.test.ts`
Expected: FAIL (route not found).

- [ ] **Step 3: Implement** `drafts.ts`, `mailDrafts.ts`, the app wiring and the move of the quote header builder (update `sendUserEmail.ts` to import it).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailDrafts.test.ts test/sendEmail.test.ts test/mail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/drafts.ts apps/api/src/routes/mailDrafts.ts apps/api/src/app.ts apps/api/src/jobs/handlers/sendUserEmail.ts apps/api/test/mailDrafts.test.ts
git commit -m "feat(mail): drafts in the user's Outlook — new, reply, reply all, forward; open, save, discard; recipient suggestions"
```

---

### Task 7: Draft files — attachments, inline pictures, template files

**Files:**
- Modify: `apps/api/src/mail/drafts.ts`, `apps/api/src/routes/mailDrafts.ts`, `apps/api/src/mail/files.ts` (export `checkUpload(file)` for one file), `apps/api/src/mail/templateFiles.ts` (export the file reading used by `outgoingWithFiles`)
- Test: `apps/api/test/mailDraftFiles.test.ts`

**Interfaces:**
- Consumes: Task 2 `DraftAttachmentUpload`, `DraftTemplateApply`; Task 3 `addAttachment`, `removeAttachment`; `sniff`, `cleanFileName`, `templateFiles`, `filesToSend`.
- Produces:
  - `export interface DraftFile { id: string; name: string; contentType: string; size: number; inline: boolean; contentId: string | null }` (stored in `email_messages.draft_files`; `attachment_names` keeps the non-inline names).
  - `export type DraftFileView = Omit<DraftFile, 'contentId'> & { contentId: string | null; dataUrl: string | null }` — `dataUrl` (`data:<type>;base64,…`) only for inline pictures, so the editor can show them.
  - `export async function addDraftFile(graph, user, m, upload: DraftAttachmentUpload): Promise<DraftFileView>` — bytes checked by `sniff` (an inline one must be PNG, JPEG or GIF), size ≤ `TEMPLATE_ATTACHMENTS_MAX_BYTES`, at most 20 files; inline content-id = `img-<first 16 hex of sha256>@dait`; `addAttachment` on the Outlook draft; row updated.
  - `export async function removeDraftFile(graph, user, m, fileId: string): Promise<void>` (Graph 404 tolerated).
  - `export async function applyTemplateFiles(graph, user, m, body: DraftTemplateApply): Promise<DraftFileView[]>` — the template's inline pictures and the kept attachments (`templateFiles` rules: `409 template_files_missing`) copied onto the draft with their own content-ids; previously applied template files of the draft are removed first.
  - `saveDraft` passes the draft's inline content-ids as `cids`, and removes inline files whose `cid:` no longer appears in the saved HTML.
  - Routes: `POST /mail/drafts/:id/files` (body `DraftAttachmentUpload`, `bodyLimit: FORMATTED_BODY_LIMIT`, `perUser(60)`) → 201 `DraftFileView`; `DELETE /mail/drafts/:id/files/:fileId` → 204 (`fileId` matches `/^[A-Za-z0-9+/=_-]{1,1024}$/`, else 404); `POST /mail/drafts/:id/template` (body `DraftTemplateApply`) → `{ files: DraftFileView[] }`. All own drafts only (403 `view_only` / 404 as Task 6).
  - `openDraft` returns `files` with `dataUrl` for inline pictures (read with `attachmentContent`, capped at `TEMPLATE_ATTACHMENTS_MAX_BYTES`; on failure `dataUrl: null`).

- [ ] **Step 1: Write the failing tests**

```ts
it('attaches a PDF to the Outlook draft and lists it; removes it', async () => {
  const res = await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'Proposal.pdf', data: PDF_BASE64 });
  expect(res.json()).toMatchObject({ name: 'Proposal.pdf', contentType: 'application/pdf', inline: false, dataUrl: null });
  expect(attaches).toEqual([['D1', expect.objectContaining({ name: 'Proposal.pdf', isInline: undefined })]]);
});
it('an inline picture gets a content-id; its cid: survives the save sanitiser; a removed picture is detached on save', ...
it('refuses a .pdf whose bytes are HTML (422 attachment_type), over 2.5 MB (413), the 21st file (422)', ...
it('applying a template copies its inline pictures and kept attachments onto the draft; files replaced since → 409 template_files_missing', ...
it("another user's draft files are 403 view_only", ...
it('opening a draft returns inline pictures as data URLs for the editor', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailDraftFiles.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailDraftFiles.test.ts test/mailDrafts.test.ts test/emailTemplates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail apps/api/src/routes/mailDrafts.ts apps/api/test/mailDraftFiles.test.ts
git commit -m "feat(mail): attachments, inline pictures and template files on the Outlook draft"
```

---

### Task 8: Send, Undo, Schedule — routes, the worker, sync and list

**Files:**
- Create: `apps/api/src/mail/send.ts`
- Modify: `apps/api/src/routes/mailDrafts.ts`, `apps/api/src/jobs/types.ts` (`SendUserEmailPayload`), `apps/api/src/jobs/handlers/sendUserEmail.ts`, `apps/api/src/mail/outgoing.ts` (`recordOnLead` without `followUpDays`), `apps/api/src/worker.ts` (`WORKER_LANES`), `apps/api/src/jobs/handlers/syncMailbox.ts` (`storeMessage`), `apps/api/src/mail/list.ts` (views `drafts`, `scheduled`), `apps/api/src/routes/mail.ts` (`listItem.scheduledAt`)
- Test: `apps/api/test/mailSend.test.ts` (new), `apps/api/test/sendEmail.test.ts`, `apps/api/test/syncMailbox.test.ts`, `apps/api/test/mailList.test.ts`, `apps/api/test/workerLanes.test.ts`

**Interfaces:**
- Consumes: Task 2 `DraftSend`, `SendFollowUp`, `UNDO_SEND_SECONDS`, `localNow`, `instantIn`; Task 3 `sendDraft`; Task 4 `openFollowUpTask`, `syncFollowUpTask`, `TASK_DURATION`; Task 6 `saveDraft`, `DraftError`; `recordOnLead`, `lockLeads`, `canUserSeeLead`, `notifyUser`, `audit`.
- Produces (`jobs/types.ts`): `SendUserEmailPayload` gains `draft?: true` and `followUp?: SendFollowUp & { leadId: number }`.
- Produces (`mail/send.ts`):
  - `export const SCHEDULE_MIN_MS = 60_000; export const SCHEDULE_MAX_DAYS = 365`
  - `export async function queueDraftSend(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftSend, now?: Date): Promise<{ id: number; sendAt: string; undoUntil: string | null; followUp: { date: string; time: string } | null }>` — saves first (`saveDraft`); at least one To/Cc/Bcc (`400 no_recipients`); `at` null → `sendAt = now + 10 s`, `undoUntil = sendAt`; `at` set → within 1 minute … 365 days (`400 schedule_time`), `undoUntil: null`, row `scheduledAt = at`. A `followUp` needs the draft's lead, visible and open (else it is dropped and `followUp: null` is answered), an instant `instantIn(date, time, user.timezone)` later than the send instant (`400 follow_up_time`), and an assignee who can see the lead (`400 cannot_assign_hidden`; others than self only with `view_all_leads`, else `403 forbidden`). In one transaction: row `status 'queued'` (folder stays `drafts`), then `enqueue('send_user_email', { emailMessageId, draft: true, followUp? }, { runAt: sendAt, maxAttempts: 5 })`. Audited with the message id only.
  - `export async function unsend(user: AuthUser, m: EmailMessage): Promise<DraftView>` — in one transaction: `job.deleteMany({ where: { type: 'send_user_email', status: 'queued', payload: { path: ['emailMessageId'], equals: m.id } } })`; count 0 → `409 already_sent`; else row back to `status 'draft'`, `scheduledAt: null`. Returns `openDraft`. Used by Undo, Cancel and Edit.
  - `export async function sendNow(user: AuthUser, m: EmailMessage): Promise<void>` — the queued job's `runAt = now` (none queued → `409 already_sent`); `scheduledAt: null`.
  - Routes: `POST /mail/drafts/:id/send` (body `DraftSend`, `bodyLimit: FORMATTED_BODY_LIMIT`, `perUser(30)`) → 202 the result; `POST /mail/:id/unsend` → `DraftView`; `POST /mail/:id/send-now` → 204. Another user's → 403 `view_only`.
- Produces (worker):
  - `sendUserEmailHandler` with `payload.draft`: same claim (`queued` → `sending`; found `sending` → failed `interrupted_may_have_sent`, never resent), own connected mailbox, then `graph.sendDraft(account, msg.graphId)`. Success → in one transaction: row `status 'sent'`, folder `sent`, `graphId: null` (Outlook gives the Sent Items copy a new id; the sync claims it with `claimCrmCopy`), `occurredAt: now`, `scheduledAt: null`; then on the lead (when `leadId` and the lead still exists and is visible to the sender): `recordOnLead(tx, user, lead, msg, subject)` (Email sent line, New/Not Contacted → Contacted); then the follow-up when given: re-check the assignee can see the lead (else assign to the sender), create the task `{ origin: 'email_follow_up', title, dueDate, dueTime: time, kind, durationMinutes: TASK_DURATION for call/meeting, priority, note, assignedToId }`, notify the assignee when not the sender, and when `updateLead` and the lead is open: lock, `nextFollowUp = date`, `syncFollowUpTask`, audit `{ before: { nextFollowUp }, after: { nextFollowUp, emailFollowUpTaskId } }`. If that transaction fails, the row is still marked sent (best effort) and the error logged without content.
  - Failure for a draft send: auth failure → account `error`, row `status 'failed'`, `lastError 'mailbox_needs_reconnect'`; Graph 404 → `'draft_gone'`, no retry; last attempt → failed. A failed draft send stays in folder `drafts` (status `failed`) and the sender is notified: `Your email "<subject>" could not be sent` with link `/email?folder=drafts` (the notification text is the sender's own subject, shown only to them).
  - `WORKER_LANES` gains `{ name: 'send', types: ['send_user_email'] }`; `send_user_email` leaves the `mail` lane.
- Produces (sync, `storeMessage`): an existing row with `source 'crm'` and status `queued` or `sending` is left untouched (no folder/read/flag change).
- Produces (list): view `drafts` = folder `drafts` and status in `draft`, `failed`; view `scheduled` = `source 'crm'`, status `queued`/`sending`; list items gain `scheduledAt: string | null`.

- [ ] **Step 1: Write the failing tests** (`mailSend.test.ts`; `runOnce` with the send lane and a `fakeGraph`)

```ts
it('Send queues the draft 10 s ahead; nothing on the lead yet; the job sends the Outlook draft, then files the lead effects', async () => {
  const res = await call('POST', `/api/mail/drafts/${d.id}/send`, repCookie, { ...fields, followUp: fu });
  expect(res.json()).toMatchObject({ undoUntil: expect.any(String), followUp: { date: '2026-12-01', time: '09:00' } });
  expect(await prisma.task.count({ where: { origin: 'email_follow_up' } })).toBe(0);
  await jobsDue(); // run_at moved to now
  expect(sent).toEqual(['D1']);
  expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'sent', folder: 'sent', graphId: null });
  expect(await prisma.task.findFirstOrThrow({ where: { origin: 'email_follow_up' } })).toMatchObject({ title: 'Follow up: Proposal', dueTime: '09:00', priority: 'high', note: 'Ask the CTO' });
  expect(ymd((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp)).toBe('2026-12-01');
  expect(await prisma.leadActivity.count({ where: { leadId: lead.id, title: 'Email sent · Proposal' } })).toBe(1);
});
it('Undo inside the window: job gone, row back in Drafts, no task, lead untouched', ...
it('Undo racing the worker: once the job is claimed, Undo is 409 already_sent and the mail is sent exactly once (Review Focus 1)', async () => {
  await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { status: 'running', lockedAt: new Date() } });
  expect((await call('POST', `/api/mail/${d.id}/unsend`, repCookie)).json()).toEqual({ error: 'already_sent' });
  expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('queued');
});
it('a send interrupted after the claim is failed, back in Drafts, notified, never sent again (Review Focus 2)', ...
it('a job still queued after a restart sends at its time (the row and job are in the database)', ...
it('scheduled: at must be 1 minute to 365 days ahead; scheduledAt set; Scheduled lists it; Send now moves the job; Cancel returns it to Drafts', ...
it('a follow-up before the send instant is 400 follow_up_time; Kolkata 09:00 is stored as 09:00 on the user day (Review Focus 5)', ...
it('a follow-up on a closed lead, or without a lead, is dropped; assigning to someone who cannot see the lead is 400 cannot_assign_hidden', ...
it('the draft was deleted in Outlook before a scheduled send: failed draft_gone, no retry, notified (Review Focus 3)', ...
it("send, unsend and send-now on another user's message are 403 view_only", ...
it('no recipients: 400 no_recipients', ...
// syncMailbox.test.ts
it('the CRM draft read back from Outlook Drafts keeps its row; while queued it is left alone; the Sent Items copy claims the sent row (Review Focus 4)', ...
// mailList.test.ts
it('Drafts lists drafts and failed sends, not queued ones; Scheduled lists queued with scheduledAt', ...
// workerLanes.test.ts
it('send_user_email has its own lane', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w apps/api -- test/mailSend.test.ts test/syncMailbox.test.ts test/mailList.test.ts test/workerLanes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Keep the existing non-draft path of the handler (quotations, Mailer) unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api -- test/mailSend.test.ts test/sendEmail.test.ts test/syncMailbox.test.ts test/mailList.test.ts test/workerLanes.test.ts test/quotationSend.test.ts test/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(mail): send a draft with a 10-second undo, schedule send, send now and cancel; lead effects and the follow-up task when the mail leaves"
```

---

### Task 9: Web foundations — draft hooks, icons, date labels

**Files:**
- Create: `apps/web/src/api/drafts.ts`, `apps/web/src/pages/email/sendDates.ts`
- Modify: `apps/web/src/components/Icons.tsx`, `apps/web/src/i18n/labels.ts` (`errorText`), `apps/web/src/api/mail.ts` (`MailItem.scheduledAt`), locales
- Test: `apps/web/test/draftHooks.test.tsx`, `apps/web/test/sendDates.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8 response shapes; Task 2 presets.
- Produces (`api/drafts.ts`): types `DraftView`, `DraftFileView`, `Recipient`, `DraftFields = { to: string[]; cc: string[]; bcc: string[]; subject: string; bodyHtml: string; leadId?: number | null; projectId?: number | null }`, `SendFollowUp` (re-exported), `SendResult`;
  - `useDraft(id: number | null)`; `useCreateDraft()` (`DraftCreate` → `DraftView`); `useDiscardDraft()`;
  - `useAutoSave(id: number | null, fields: DraftFields, opts: { enabled: boolean }): { savedAt: string | null; saving: boolean; error: string | null; flush(): Promise<void> }` — PATCHes 2 s after the last change, at most one request in flight (a change while saving queues one more), `flush()` saves now; error code from `ApiError` (`draft_gone`, …);
  - `useDraftFile(id)` (`add(file: File, inline: boolean)` reads the file as base64; `remove(fileId)`), `useApplyTemplateFiles(id)`;
  - `useSendDraft()` (`{ id, fields, at, followUp }` → `SendResult`), `useUnsend()`, `useSendNow()`; all invalidate the mail list, meta, nav counts and, when `leadId`, the lead.
  - `useRecipientSuggestions(q: string)` (debounced 250 ms, `q.length ≥ 2`), `resolveRecipients(addresses)`.
- Produces (`sendDates.ts`): `export function whenLabel(day: string, time: string, timezone: string, lang: string, now?: Date): string` → `Tue 1 Dec 2026, 09:00` (long, the follow-up cards) and `export function whenShort(...)` → `Tue 1 Dec, 09:00` (toast, list); `export function savedLabel(iso: string, timezone: string): string` → `14:32`.
- Icons: `popout`, `pen`, `marker`, `bullets`, `numbers`, `indent`, `outdent`, `image` (mockup `P` map paths).
- `errorText` cases: `draft_gone` → `This draft was removed in Outlook.`; `already_sent` → `Too late: the email was sent.`; `no_recipients` → `Add at least one recipient.`; `schedule_time` → `Choose a time at least a minute from now and within a year.`; `follow_up_time` → `Choose a follow-up time after the email is sent.`; `no_mailbox` → existing text; `attachment_type` → `This type of file cannot be attached here. Attach it in Outlook.`; `attachments_too_large` → `Files over 2.5 MB can be attached in Outlook.`; `signature_too_long` → `The signature is too long.`

- [ ] **Step 1: Write the failing tests**

```ts
// sendDates.test.ts
test('labels: long and short, 24-hour, in the user zone and language', () => {
  expect(whenLabel('2026-12-01', '09:00', 'Europe/London', 'en')).toBe('Tue 1 Dec 2026, 09:00');
  expect(whenShort('2026-12-01', '09:00', 'Europe/London', 'es')).toBe('mar 1 dic, 09:00');
});
// draftHooks.test.tsx
it('auto-save waits 2 s after typing, sends one request at a time, and reports the saved time', ...
it('auto-save meeting 409 draft_gone reports the error and stops saving', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/draftHooks.test.tsx test/sendDates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/draftHooks.test.tsx test/sendDates.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/draftHooks.test.tsx apps/web/test/sendDates.test.ts
git commit -m "feat(web): draft hooks with auto-save, send/undo hooks, writing icons and date labels"
```

---

### Task 10: Mail editor toolbar

**Files:**
- Modify: `apps/web/src/components/MessageEditor.tsx` (prop `toolbar?: 'basic' | 'mail'`, default `basic` — every existing use unchanged), `apps/web/src/lib/richText.ts`, `apps/web/src/styles/app.css` (mockup `.tbar`, `.tb`, `.tb-sep`, `.tb .clr`, `.tb-a`, `.rbody`, `.sig`), locales
- Test: `apps/web/test/messageEditor.test.tsx`, `apps/web/test/richText.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `MessageEditor` with `toolbar="mail"`: always formatted (never the textarea), the frame's base font `Aptos, Calibri, "Segoe UI", Arial, sans-serif` 14px, and the mockup toolbar (`role="toolbar"`, label `Formatting`), in order: `Font` select (Aptos, Arial, Calibri, Georgia, Montserrat), `Size` select (11, 12, 14), `Bold`, `Italic`, `Underline`, `Font colour` (palette of 8: #1F1533, #C62828, #E65100, #2E7D32, #1565C0, #6811CF, #6B7280, #FFFFFF), `Highlight` (#FFE14D, #B9F6CA, #B3E5FC, #F8BBD0, none), `Bullets`, `Numbering`, `Decrease indent`, `Increase indent`, `Insert link`, `Insert picture`, `Attach file`, `Template`, `Signature`. Commands run with `styleWithCSS` on (`fontName`, `foreColor`, `hiliteColor`, `underline`, `indent`, `outdent`); size: `fontSize` 7 then every `font[size="7"]` / `span` with `xxx-large` becomes `<span style="font-size:{n}pt">` (in `richText.ts`: `export function applyFontSize(doc: Document, pt: 11 | 12 | 14): void`).
  - New props (used only with `mail`): `onPicture?: (file: File) => Promise<{ contentId: string; dataUrl: string } | null>` (the editor inserts `<img src="{dataUrl}" data-cid="{contentId}">` at the caret), `onAttach?: (files: File[]) => void`, `onTemplate?: (anchor: HTMLElement) => void`, `signatureHtml?: string | null`.
  - `Signature` button inserts the `.dait-sig` block at the end, or replaces the one there.
  - `export function toSendHtml(html: string): string` (`richText.ts`) — every `<img data-cid="x" src="data:…">` becomes `<img src="cid:x">`; `export function toEditorHtml(html: string, files: { contentId: string | null; dataUrl: string | null }[]): string` — the reverse for opening a draft.
  - The frame's `keydown` events stay inside it, so release 2's shortcuts never see typing.

- [ ] **Step 1: Write the failing tests**

```tsx
it('mail toolbar shows the mockup controls in order', () => {
  render(<MessageEditor toolbar="mail" id="b" label="Message" value={{ text: '', html: '<p></p>' }} onChange={() => {}} />);
  expect(within(screen.getByRole('toolbar', { name: 'Formatting' })).getAllByRole(/button|combobox/).map((c) => c.getAttribute('aria-label') ?? c.getAttribute('title')))
    .toEqual(['Font', 'Size', 'Bold', 'Italic', 'Underline', 'Font colour', 'Highlight', 'Bullets', 'Numbering', 'Decrease indent', 'Increase indent', 'Insert link', 'Insert picture', 'Attach file', 'Template', 'Signature']);
});
it('the basic toolbar of the Mailer and templates is unchanged', ...
it('Signature inserts the signature block once and replaces it on a second click', ...
it('Insert picture calls onPicture and inserts the returned picture', ...
```

```ts
test('toSendHtml turns editor pictures into cid: and toEditorHtml back', () => {
  expect(toSendHtml('<p><img data-cid="img-1@dait" src="data:image/png;base64,AA=="></p>')).toBe('<p><img src="cid:img-1@dait"></p>');
});
test('applyFontSize wraps the selection in a pt span', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/messageEditor.test.tsx test/richText.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr labels.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/messageEditor.test.tsx test/richText.test.ts test/mailer.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/messageEditor.test.tsx apps/web/test/richText.test.ts
git commit -m "feat(web): mail editor toolbar — font, size, underline, colour, highlight, indent, picture, attach, template, signature"
```

---

### Task 11: Send flow — follow-up box, Schedule send, Undo toast

**Files:**
- Create: `apps/web/src/components/send/FollowUpDialog.tsx`, `apps/web/src/components/send/ScheduleSend.tsx`, `apps/web/src/components/send/UndoSend.tsx`, `apps/web/src/components/send/useSendFlow.ts`, `apps/web/src/components/send/SendButton.tsx`
- Modify: `apps/web/src/components/Shell.tsx` (mounts `UndoSendProvider`), `apps/web/src/styles/app.css` (mockup `.modal.fu`, `.fu-*`, `.radio-card`, `.split`, `.schedpop`, `.utoast` under `.wm-send`), locales
- Test: `apps/web/test/sendFlow.test.tsx`

**Interfaces:**
- Consumes: Task 9 hooks and labels; Task 2 `sendFollowUpChoices`, `DEFAULT_SEND_FOLLOW_UP`, `schedulePresets`, `instantIn`, `localNow`; `useUsers` (assignees, as `TaskModal`).
- Produces:
  - `SendButton({ onSend, onSchedule, options: 'menu' | 'popover', disabled })`: the split button `Send` + `▾` (`aria-label="Send options"`). `menu` (inline editor, mockup state 2): ▾ opens a menu `Send`, `Schedule send…`, and `Schedule send…` opens `ScheduleSend`. `popover` (full page, state 3): ▾ opens `ScheduleSend` directly.
  - `ScheduleSend({ timezone, recipientZone, onPick, onClose })`: heading `Schedule send`; the `schedulePresets` as `Later today` / `Tomorrow morning` / `Monday morning` with `{whenLabel}`; a custom row (date input, 24-hour time input); when `recipientZone`: `Recipient's time: {label} — sent at their {HH:MM}`; buttons `Cancel` and `Schedule`. `onPick(at: Date)` with `instantIn(day, time, timezone)`.
  - `FollowUpDialog({ lead: { number: string; company: string; status: string }, who: string, subject: string, baseDay: string, onSend(followUp: SendFollowUp | null), onCancel })`: the mockup box (`role="dialog"`, title `Set the next follow-up`, lead chip, `Your email is ready to send. When should you follow up with {who}?`, radio cards with `Default` on In 3 working days, custom date/time row, `Working days skip Saturday and Sunday. Times are 24-hour.`, Task title, Assigned to (`Me ({name})` then others with `view_all_leads`), Type, Priority, Note with placeholder `e.g. Ask whether the CTO has reviewed the examples`, `Also update the lead's next follow-up`, the live note `Added to your Tasks · due {whenLabel}.` (`Added to {name}'s Tasks` for another assignee), buttons `Send without follow-up` (link), `Cancel`, `Send and add follow-up` (primary)). A custom time not after the send instant shows `Choose a follow-up time after the email is sent.` and disables the primary button.
  - `useSendFlow(opts: { draftId: () => Promise<number>; fields: () => DraftFields; lead: { id: number; number: string; company: string; status: string; open: boolean } | null; who: string; subject: string; onSent(r: SendResult): void; onUndone(d: DraftView): void }): { send(): void; schedule(at: Date): void; dialog: ReactNode }` — the one implementation for every screen: with an open lead → the follow-up box (base day = today, or the scheduled day), then `useSendDraft`; without → straight to `useSendDraft`. After an immediate send → `UndoSend.show(...)`; after a scheduled one → toast `Scheduled for {whenShort}`.
  - `UndoSendProvider` + `useUndoSend(): { show(r: { messageId: number; until: string; followUp: { date: string; time: string } | null; onUndone(d: DraftView): void }): void }`: the mockup `.utoast` (`role="status"`), text `Sent · follow-up added for {whenShort}` or `Sent`, `Undo` button, the progress bar running to `until`. Undo → `useUnsend`; success → `onUndone(draft)`; `409 already_sent` → toast `Too late: the email was sent.` It stays mounted across route changes (Shell).

- [ ] **Step 1: Write the failing tests**

```tsx
it('Send with a lead opens the follow-up box: default In 3 working days Tue 1 Dec 2026, 09:00; title Follow up: <subject>', async () => {
  vi.setSystemTime(new Date('2026-11-26T14:30:00Z'));
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const box = screen.getByRole('dialog', { name: 'Set the next follow-up' });
  expect(within(box).getByRole('radio', { name: /In 3 working days/ })).toBeChecked();
  expect(within(box).getByText('Tue 1 Dec 2026, 09:00')).toBeInTheDocument();
  expect(within(box).getByLabelText('Task title')).toHaveValue('Follow up: Proposal: Northwind Health patient portal UX');
});
it('Send and add follow-up posts the follow-up (Call → call, High, note, update lead) and shows the Undo toast', async () => {
  expect(lastSend()).toMatchObject({ at: null, followUp: { date: '2026-12-01', time: '09:00', kind: 'call', priority: 'high', note: 'Ask the CTO', updateLead: true } });
  expect(screen.getByRole('status')).toHaveTextContent('Sent · follow-up added for Tue 1 Dec, 09:00');
});
it('Send without follow-up posts followUp null; the toast says Sent', ...
it('no lead: no box, plain send', ...
it('Undo calls unsend and hands back the draft; 409 already_sent shows Too late', ...
it('Schedule send: presets at 14:30 with Later today, custom time, recipient time line; Schedule posts at; the box counts from the scheduled day', ...
it('Assigned to lists only me without view_all_leads', ...
it('a custom follow-up before the send time disables Send and add follow-up', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/sendFlow.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/sendFlow.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/sendFlow.test.tsx
git commit -m "feat(web): send flow — follow-up box after Send, Schedule send and the Undo toast, one implementation"
```

---

### Task 12: Inline Reply, Reply all, Forward (state 2)

**Files:**
- Create: `apps/web/src/pages/email/compose/RecipientField.tsx`, `apps/web/src/pages/email/compose/DraftComposer.tsx`, `apps/web/src/pages/email/compose/InlineReply.tsx`, `apps/web/src/pages/email/compose/QuotedText.tsx`, `apps/web/src/pages/email/compose/FileChips.tsx`
- Modify: `apps/web/src/pages/email/ReadingPane.tsx`, `apps/web/src/pages/email/useMailCommands.ts` (`onCompose` → `onReply(originalId, kind)`), `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/pages/email/menus.tsx` (row menu Reply/Reply all/Forward), `apps/web/src/styles/app.css` (mockup `.reply`, `.rtop`, `.fld`, `.rcp`, `.lead-tag`, `.quoted-tog`, `.quoted`, `.att-chips`, `.att-chip`, `.sent-note`), locales
- Delete: `apps/web/src/pages/email/replyStart.ts` (the server builds recipients now)
- Test: `apps/web/test/inlineReply.test.tsx`; `apps/web/test/emailReading.test.tsx` and `apps/web/test/emailCommands.test.tsx` (Reply cases now open the inline editor); `apps/web/test/composeReply.test.tsx` deleted

**Interfaces:**
- Consumes: Task 9 hooks; Task 10 `MessageEditor toolbar="mail"`, `toSendHtml`, `toEditorHtml`; Task 11 `SendButton`, `useSendFlow`; Task 5 `useSignature`; release 2 `NewMailMenu`'s template list (`useTemplates`), `fillTemplateHtml`.
- Produces:
  - `RecipientField({ label: 'To' | 'Cc' | 'Bcc', value: string[], onChange, autoFocus? })`: chips (`.rcp`: initials avatar, name or address, `.lead-tag` with the lead number when known, `Remove` button) and an input (`aria-label` `Add recipient` / `Add Cc` / `Add Bcc`) taking Enter, comma, semicolon, blur and paste of several addresses; invalid text stays in the input marked `aria-invalid`; suggestions list from `useRecipientSuggestions`; chips resolved with `resolveRecipients` once.
  - `DraftComposer({ draft: DraftView, variant: 'inline' | 'page', onClose(reason: 'sent' | 'discarded' | 'popout'), header?: ReactNode })`: the shared writing body: the `.rtop` row (`SendButton` with `menu` inline / `popover` page, `Discard`, `Draft saved {hh:mm}` with the check icon or `Saving…`, inline only the `Pop out` icon button), To (with `Cc` and `Bcc` link buttons revealing those rows; shown when not empty), Cc, Bcc, then (page only) the slots the page adds, the toolbar + body (`MessageEditor toolbar="mail"`, signature from `useSignature`), `QuotedText`, `FileChips`. It keeps `DraftFields` in state, runs `useAutoSave`, uploads pictures/files with `useDraftFile`, applies templates (Template button → the templates menu; fills the subject when empty and the body with `fillTemplateHtml` from the draft's lead; then `useApplyTemplateFiles`), and sends with `useSendFlow` (`draftId` = its id, `fields` = current fields with `bodyHtml: toSendHtml(...)`). A pristine draft (nothing changed since it opened) is discarded when the composer unmounts without sending; `draft_gone` shows `This draft was removed in Outlook.` and a `Save as a new draft` button (creates a new draft with the current fields).
  - `QuotedText({ html })`: the `…` toggle (`title="Show quoted text"`, `aria-expanded`), the quote shown in `MailBody` (sandboxed, auto-height) when open.
  - `FileChips({ files, onRemove })`: `.att-chip` with type badge, name, size, `Remove attachment`.
  - `InlineReply({ originalId, kind, draftId? })`: creates the draft (`useCreateDraft({ kind, replyToId })`) or opens `draftId`, then renders `DraftComposer variant="inline"` at the top of the conversation (above the newest message). After sending, the slot shows the `.sent-note` `Reply sent to {name} · follow-up task added · it will appear here and on {lead}'s timeline.` (without the follow-up part when none). Pop out → `/email/new?draft={id}`. Undo → the inline editor opens again on the returned draft.
  - `ReadingPane` gains `composing: { kind: 'reply' | 'replyAll' | 'forward'; draftId?: number } | null` and the footer/per-message Reply buttons call `onReply`. Your own draft replies in the conversation show as a collapsed row `Draft · {preview}` with `Continue editing` (opens `InlineReply` with that `draftId`).
  - `useMailCommands`: `reply`, `replyAll`, `forward` open the inline editor for the target (keyboard `R`, `Shift+R`, `F` too); the view-only rule is unchanged.

- [ ] **Step 1: Write the failing tests**

```tsx
it('Reply opens the inline editor above the newest message: To chip with lead tag, Cc, toolbar, signature, quote folded', async () => {
  await user.click(within(pane).getAllByRole('button', { name: 'Reply' })[0]!);
  const editor = await screen.findByRole('form', { name: 'Reply' });
  expect(within(editor).getByText('Maria Gómez')).toBeInTheDocument();
  expect(within(editor).getByText('LD-1178')).toHaveClass('lead-tag');
  expect(within(editor).getByRole('button', { name: 'Show quoted text' })).toHaveAttribute('aria-expanded', 'false');
  expect(postBodies('/api/mail/drafts')[0]).toEqual({ kind: 'reply', replyToId: 1 });
});
it('typing saves the draft after 2 s and shows Draft saved hh:mm', ...
it('Bcc link reveals Bcc; addresses typed with commas become chips; an invalid one stays marked', ...
it('Discard deletes the draft and closes the editor; closing an untouched editor deletes it too', ...
it('Send (lead) → follow-up box → Send and add follow-up → sent note and Undo toast; Undo reopens the editor with the draft', ...
it('Pop out goes to /email/new?draft=<id>', ...
it('R, Shift+R and F open the editor; typing r inside the editor or a recipient field opens nothing', ...
it('view only: no Reply buttons enabled, no draft created', ...
it('a draft reply in the conversation shows Continue editing', ...
it('draft_gone on save shows the message and Save as a new draft', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/inlineReply.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr. Remove `replyStart.ts` and its test cases.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web && npm run typecheck`
Expected: PASS (all web unit tests).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src apps/web/test
git commit -m "feat(web): inline Reply, Reply all and Forward in the conversation, with drafts in Outlook, Bcc, quote, files and the send flow"
```

---

### Task 13: Full-page New message (state 3)

**Files:**
- Create: `apps/web/src/pages/email/compose/NewMessagePage.tsx`, `apps/web/src/pages/email/compose/LeadPicker.tsx`, `apps/web/src/pages/email/compose/ComposeLeadSummary.tsx`
- Modify: `apps/web/src/router.tsx` (`{ path: 'email/new', element: <EmailPage /> }` before `email/:id`), `apps/web/src/pages/email/EmailPage.tsx` (route switch; `?compose=1` → `/email/new?…` with replace; command bar hidden on the page), `apps/web/src/pages/email/useMailCommands.ts` (`new` → navigate), `apps/web/src/pages/email/menus.tsx` (`NewMailMenu`: New mail → `/email/new`, a template → `/email/new?template={id}`), `apps/web/src/styles/app.css` (mockup `.cpage`, `.cp-top`, `.cp-grid`, `.cp-main`, `.cp-lead`, `.leadpick`, `.tplbar`, `.fld select.from`, `.fld .hintr`, the 1360 px rule), locales
- Delete: `apps/web/src/pages/email/ComposeModal.tsx`
- Test: `apps/web/test/newMessage.test.tsx`; `apps/web/test/composeProject.test.tsx` rewritten for the page; `apps/web/test/emailPage.test.tsx` (`?compose=1` case)

**Interfaces:**
- Consumes: Task 12 `DraftComposer`, `RecipientField`; Task 9 `useCreateDraft`, `useDraft`; release 2 `LeadPanel` data shape (`DraftView.lead`), `useLeads` search, `useCompanyProjects`.
- Produces:
  - Route `/email/new` with query `draft`, `lead`, `company`, `project`, `template`. Without `draft` it creates a `new` draft (`leadId`, `projectId` from the query) and replaces the address with `?draft={id}`, so reload and Back work. Browser Back returns to where the user was.
  - `NewMessagePage`: the top bar stays (release 2 `MailTopBar`); the command bar and panes are not shown. `.cp-top`: crumb `Email / New message` (Email links to `/email`) and `← Back to Inbox`. The main card is `DraftComposer variant="page"` with, in order: `From` (`select` with the one own address `{name} <{address}>`, hint `Your mailbox`), To/Cc/Bcc, `Subject`, `Lead` (`LeadPicker`, hint `Filed on the lead's timeline when sent`), `Project` (only when the lead's company has projects or the link carried one; release 3B tagging), the template bar `Template: {name} · fields filled from {lead} · Change` once a template is applied (from `?template=` or the toolbar), toolbar, body, signature, attachments. The right aside `ComposeLeadSummary` (`aria-label="Chosen lead"`): `Lead for this email`, logo initials, company, site · place, badges number and stage, Contact, Owner, Next follow-up, Last activity, Value, `Recent on the lead` (two lines), `Open lead`; without a lead: `No lead chosen` and the note `Choose a lead to file this email on its timeline.`
  - `LeadPicker({ value, companyId?, onChange })`: the `.leadpick` button `{number} · {company} · {stage}` (or `Choose a lead`) opening a search menu (`Search leads by LD number or company`, the existing leads search, debounced), plus `No lead`. Choosing a lead with an empty To adds the lead contact's email.
  - After Send: back to `/email?folder=sent` (immediate) or `/email?folder=scheduled` (scheduled); Undo → `/email/new?draft={id}`. Discard → back.
  - `?compose=1&company=&lead=&project=` (Projects list Email buttons) → `/email/new?company=&lead=&project=` (replace).

- [ ] **Step 1: Write the failing tests**

```tsx
it('New mail opens /email/new: draft created, address becomes ?draft=, command bar hidden, crumb and Back to Inbox', async () => {
  await user.click(screen.getByRole('button', { name: 'New mail' }));
  expect(await screen.findByRole('region', { name: 'New message' })).toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: /Home/ })).toBeNull();
  expect(where()).toBe('/email/new?draft=7');
});
it('fields in order: From (Your mailbox), To, Cc/Bcc links, Subject, Lead with its hint, toolbar, body with signature', ...
it('choosing a lead fills an empty To with its contact and shows the lead summary on the right', ...
it('New from template fills subject and body from the lead and shows the template bar with Change', ...
it('Send (lead) → follow-up box → Undo toast → lands on Sent; Undo comes back to the draft', ...
it('Schedule send from the ▾ popover posts at and lands on Scheduled', ...
it('a Projects-list link ?compose=1&company=&lead=&project= opens the page with lead and project', ...
it('browser Back from the page returns to the inbox', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/newMessage.test.tsx test/composeProject.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr. Delete `ComposeModal.tsx` and the strings only it used.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src apps/web/test
git commit -m "feat(web): full-page New message with its own route, lead picker, template bar and lead summary; Compose dialog removed"
```

---

### Task 14: Drafts and Scheduled folders on the screen

**Files:**
- Modify: `apps/web/src/pages/email/ReadingPane.tsx`, `apps/web/src/pages/email/MessageRow.tsx`, `apps/web/src/pages/email/menus.tsx` (`RowMenu`), `apps/web/src/pages/email/EmailPage.tsx`, locales
- Test: `apps/web/test/emailDrafts.test.tsx`

**Interfaces:**
- Consumes: Task 8 views and `scheduledAt`; Task 9 `useUnsend`, `useSendNow`; Task 12 `InlineReply`; Task 13 route.
- Produces:
  - Opening your own draft (Drafts folder): a reply draft (`replyToId`) opens its conversation with `InlineReply draftId`; any other draft opens `/email/new?draft={id}`. The release 2 note `Drafts are edited in Outlook.` is removed. A failed send in Drafts shows the banner `Not sent: {errorText(lastError)}` above the editor.
  - Scheduled folder: the row shows `Scheduled · {whenShort(scheduledAt)}` in place of the time; the reading pane shows the banner `Scheduled for {whenLabel}` with `Edit` (unsend, then open the editor), `Send now` (toast `Sending…`), `Cancel` (unsend; toast `Moved to Drafts`). The same three are in the row's right-click menu for a scheduled row. In team view these are disabled with the view-only title.

- [ ] **Step 1: Write the failing tests**

```tsx
it('a scheduled message shows Scheduled · Mon 30 Nov, 08:00 and the banner with Edit, Send now, Cancel', ...
it('Cancel moves it to Drafts; Send now posts send-now; Edit opens the editor on the returned draft', ...
it('a draft reply opens its conversation with the inline editor; a new-message draft opens the full page', ...
it('a failed send in Drafts shows Not sent with the reason', ...
it("another user's scheduled mail: Edit, Send now and Cancel disabled with the view-only title", ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -w apps/web -- test/emailDrafts.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit -w apps/web -- test/emailDrafts.test.tsx test/emailReading.test.tsx test/emailList.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test/emailDrafts.test.tsx
git commit -m "feat(web): edit drafts in the CRM; Scheduled folder with Edit, Send now and Cancel"
```

---

### Task 15: Lead page Email tab on the same send path

**Files:**
- Modify: `apps/web/src/pages/leads/EmailForm.tsx` (the follow-up-days control goes; Send ▾ with Schedule send; `useSendFlow`), `apps/web/src/api/leadEmails.ts` (`useSendLeadEmail` and `LeadEmailSend` removed), `apps/api/src/routes/leadEmails.ts` (`POST /leads/:id/emails` removed; `GET` stays), `packages/shared/src/schemas/email.ts` (`LeadEmailSend` removed), `apps/api/src/mail/outgoing.ts` (`followUpDays` removed from `Outgoing` and `recordOnLead`), locales
- Test: `apps/web/test/leadPage.test.tsx` (email cases), `apps/api/test/leadEmails.test.ts` (send cases move to the drafts API: create with `leadId`, send)

**Interfaces:**
- Consumes: Task 11 `useSendFlow`, `SendButton`; Task 9 `useCreateDraft`, `useApplyTemplateFiles`, `useDraftFile`; Tasks 6–8 routes.
- Produces: `EmailForm` keeps its layout (To, Cc chips, Project, Template, Subject, Message, template attachments) but sends through the drafts path: on Send it creates a `new` draft with `leadId` and `projectId` (or reuses the one an Undo returned), applies the template files it kept (`useApplyTemplateFiles`), and hands `useSendFlow` the fields (`to: [to]`, `cc`, `bcc: []`, `subject`, `bodyHtml`). The follow-up box replaces the old `Set follow-up in N days` control (the box appears only for an open lead, as everywhere). Send ▾ (`menu`) offers Schedule send. Undo refills the form from the returned draft and keeps its id for the next Send. The form still resets after a send, and the Emails tab keeps polling queued mail.

- [ ] **Step 1: Write the failing tests**

```tsx
it('lead page: Send opens the follow-up box (no follow-up-days control), then the Undo toast; the request goes through /api/mail/drafts', async () => {
  expect(screen.queryByLabelText(/Set follow-up in/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await user.click(within(screen.getByRole('dialog', { name: 'Set the next follow-up' })).getByRole('button', { name: 'Send and add follow-up' }));
  expect(postPaths()).toEqual(['/api/mail/drafts', '/api/mail/drafts/9/send']);
  expect(screen.getByRole('status')).toHaveTextContent(/Sent · follow-up added for/);
});
it('lead page: Undo refills the form and the next Send reuses the draft', ...
it('lead page: Schedule send from Send ▾', ...
it('lead page: a template with attachments copies them to the draft before sending', ...
```

```ts
// leadEmails.test.ts
it('POST /leads/:id/emails is gone (404); GET still lists the lead mail', ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build -w packages/shared && npm run test:unit -w apps/web -- test/leadPage.test.tsx && npm test -w apps/api -- test/leadEmails.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block, with es/fr; remove the strings only the old control used.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w apps/api && npm run test:unit -w apps/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/shared apps/api/src apps/api/test apps/web/src apps/web/test
git commit -m "feat(leads): the lead page sends through the drafts path with the follow-up box, Schedule send and Undo"
```

---

### Task 16: End-to-end flows, runbook and pending notes

**Files:**
- Create: `apps/web/e2e/emailWrite.spec.ts`
- Modify: `apps/web/e2e/email.spec.ts`, `apps/web/e2e/emailActions.spec.ts`, `apps/web/e2e/leadEmail.spec.ts`, `apps/web/e2e/templateHtml.spec.ts`, `apps/web/e2e/templateAttachments.spec.ts`, `apps/web/e2e/projects.spec.ts`, `apps/web/e2e/tasks.spec.ts`, `apps/web/e2e/settings.spec.ts`
- Modify: `docs/DEPLOYMENT.md` (new section "Web mail release 3: deploy runbook"), `docs/PENDING.md`, `README.md` (Email screen paragraph), `docs/data-model.md` if Task 1 left anything

**Interfaces:**
- Consumes: everything above; the e2e fake Graph (Task 3) and `apps/api/test/e2e-send-jobs.ts`.

- [ ] **Step 1: Update the existing specs**

`templateHtml.spec.ts`, `templateAttachments.spec.ts`, `leadEmail.spec.ts`: the send now creates a draft, goes through the follow-up box (`Send without follow-up` where the spec is not about follow-ups), and `e2e-send-jobs.ts` prints the draft's stored HTML and files; assert the same HTML/attachment facts as before. `email.spec.ts` / `emailActions.spec.ts`: Reply opens the inline editor (no dialog). `projects.spec.ts`: the Email button lands on `/email/new` with the lead and project. `tasks.spec.ts`: a High task shows the badge and note. `settings.spec.ts`: the signature card saves.

- [ ] **Step 2: Write `emailWrite.spec.ts`**

```ts
test('reply inline, save draft, send with follow-up, undo, send again; the task appears after the send runs', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  // open Re: Orbit proposal → Reply → type → "Draft saved" appears → Send → box → Send and add follow-up
  // toast "Sent · follow-up added for …" → Undo → editor back with the text
  // Send again → Send without follow-up → run e2e-send-jobs → Sent items lists it
});
test('new message full page: Back works, lead picker, Bcc, schedule send lands in Scheduled; Cancel returns it to Drafts', ...
test('typing r, e, n or Delete in the editor or a recipient field triggers no shortcut', ...
```

- [ ] **Step 3: Run the e2e specs**

Run: `npm run build && npm test -w apps/web -- e2e/emailWrite.spec.ts e2e/email.spec.ts e2e/emailActions.spec.ts e2e/leadEmail.spec.ts e2e/templateHtml.spec.ts e2e/templateAttachments.spec.ts e2e/projects.spec.ts e2e/tasks.spec.ts e2e/settings.spec.ts`
Expected: PASS.

- [ ] **Step 4: Docs**

`docs/DEPLOYMENT.md`, new section **"Web mail release 3: deploy runbook"** in the style of release 2's: only after the owner says "deploy"; backup named `dait_crm-pre-web-mail-r3.dump`; before installing, `migrate status` must list only `20261214100000_web_mail_writing` (number 28) as not applied (adds columns only), anything else = stop and ask; the worker restart picks up the new `send` lane (`pm2 restart crm-live-worker` is part of the normal deploy — say so). **Read-only check:** `SELECT count(*) FROM email_accounts WHERE kind = 'personal' AND send_as IS NOT NULL;` — if not 0, add the send-as live check below for that user. **Live check on Deepak's own mailbox, right after "Check from outside"** (every new Graph write has only met fakes), with Outlook on the web open beside it: (a) New mail → type → within seconds a draft with that subject is in Outlook's Drafts; change the text → Outlook's draft changes; add a small PDF and a picture → both are on the Outlook draft; Discard → it leaves Outlook's Drafts. (b) Reply on a lead email → the draft sits in the same conversation in Outlook; Send → Send without follow-up → wait 10 s → it arrives (send it to Deepak's own second address or a colleague), is in Sent Items in the same conversation, and the CRM shows **one** row in Sent items after the next sync (not two). (c) Send with follow-up (In 3 working days) → Undo within 10 s → nothing arrives, no task, the draft is back. (d) Schedule send for 5 minutes ahead (custom time) → it is in the CRM's Scheduled folder and in Outlook's Drafts → it arrives after 5 minutes (± 1 minute) and the follow-up task is in Tasks with its time. (e) Send-as check when step "Read-only check" found one. **Any refusal, a send that ends Failed, a duplicate row in Sent, or a 500: stop and roll back** to release 2 (`70ec558`) as in "Rolling back" (the migration only added columns, so the old code runs on it; drafts the CRM made stay in Outlook's Drafts and can be sent or deleted there; scheduled mail still queued at rollback is **not** sent by release 2 — list them first with `SELECT id, user_id, scheduled_at FROM email_messages WHERE status = 'queued' AND source = 'crm';` and tell the owners).

`docs/PENDING.md`: in "Where things stand", web-mail release 3 is ready on branch `web-mail-r3`; a section **"Ready, waiting for deploy: web-mail release 3 (branch `web-mail-r3`)"**: what changes for users (inline reply, full-page New message, drafts in Outlook, Bcc, formatting, signature in Settings, Schedule send, Undo send, the follow-up box with priority and note, Tasks High badge and note, the lead page sends the same way and the old "follow-up in N days" choice is gone); deploy = migration 28 + the live checks; and the calls flagged to the owner ("Decisions I made" of this plan, short). Update the README Email paragraph.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e apps/api/test/e2e-send-jobs.ts docs/DEPLOYMENT.md docs/PENDING.md README.md
git commit -m "test(e2e): web-mail release 3 writing flows; docs: release 3 runbook and pending notes"
```

---

### Task 17: Parity screenshots and full suite

**Files:**
- Modify: `apps/web/e2e/parity/webMail.spec.ts` (states 2, 3, 6 and the Undo toast)
- Output (not committed): `~/Documents/DAIT-CRM/parity-screenshots-web-mail/release-3/`

**Interfaces:**
- Consumes: the built screen; the mockup HTML (`#s=2`, `#s=3`, `#s=6`, `#s=2&send` for the toast); `PATCH /api/me/preferences { language }`; the release 2 parity data set (`parity-` graph ids) plus a signature for Neha.

- [ ] **Step 1: Extend the capture spec** (still skipped unless `PARITY_WEB_MAIL=1`). For each language `en`, `es`, `fr` and each viewport `1440×900` and `1280×800`:
  - state 2: Neha, the HTML conversation, Reply, a few lines typed (wait for `Draft saved`) → `state2-<w>-<lang>-app.png`;
  - state 3: New mail with a lead chosen, a Cc, a template applied and one PDF attached → `state3-<w>-<lang>-app.png`;
  - state 6: on that page, Send → the follow-up box → `state6-<w>-<lang>-app.png`;
  - toast: Send and add follow-up → the Undo toast within the 10 s → `toast-<w>-<lang>-app.png`; then Undo (nothing is left queued).
  The mockup side at the same viewports (English only) → `state2-<w>-mockup.png`, `state3-<w>-mockup.png`, `state6-<w>-mockup.png`, `toast-<w>-mockup.png`.

- [ ] **Step 2: Capture**

Run: `npm run build && PARITY_WEB_MAIL=1 PARITY_DIR=$HOME/Documents/DAIT-CRM/parity-screenshots-web-mail/release-3 npm test -w apps/web -- e2e/parity/webMail.spec.ts`
Expected: PASS. The folder holds 24 app images and 8 mockup images (plus release 2's states if the spec still captures them).

- [ ] **Step 3: Compare side by side** (open each pair; section by section: `.rtop` row, recipient rows and chips, toolbar order and icons, body font, signature, quote toggle, attachment chips, page crumb and grid, lead summary, follow-up box layout and copy, toast). Fix any difference in layout, controls, wording or order, and capture again. Translated labels must fit at 1280 (the toolbar wraps onto a second line as the mockup's does at 1440 — see the mockup screenshot of state 2). List the remaining deliberate differences, with their reason, in the hand-over (self-review list below).

- [ ] **Step 4: Run the whole suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London caffeinate -i npm run typecheck && PATH=/opt/homebrew/opt/node@24/bin:$PATH TZ=Europe/London caffeinate -i npm test && npm run build && npm test -w apps/web`
Expected: all green (shared, api, worker, web unit, deploy test, e2e). `git status` shows only the spec file to add (and the untracked `Reference/`, never added).

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/parity/webMail.spec.ts
git commit -m "test(parity): web-mail release 3 screenshots of mockup states 2, 3, 6 and the Undo toast in en, es and fr at 1440 and 1280"
```

---

## Self-review

- **Spec coverage:**
  - Inline Reply / Reply all / Forward (state 2): chips with lead tag, toolbar (font, size, B I U, colour, highlight, bullets, numbering, indent, link, picture, attach, Template, Signature), quoted text folded, Send ▾ (Send / Schedule send), Discard, Draft saved, pop-out, sent through Graph from the own mailbox so it threads → T3 (createReply*), T6, T7, T8, T10, T11, T12. Replaces ComposeModal on the Email screen → T12/T13.
  - Full-page New message (state 3) with route and Back, From, To, Cc, Bcc, Subject, Lead picker + hint, template bar, toolbar, body, signature, attachments, lead summary, command bar hidden → T13 (+ T6/T7 server).
  - Drafts auto-save to Outlook Drafts and show in Drafts → T6 (save), T8 (Drafts view), T9 (`useAutoSave`), T14 (open drafts).
  - Signature one per user, rich text, Settings, Add automatically default on, inserted on new/reply → T1, T5, T6 (`signatureBlock`), T10 (button), T12.
  - Schedule send presets and custom; Scheduled folder with Edit / Send now / Cancel; survives restarts; mechanism decided → T2, T8, T11, T14; decision recorded below.
  - Undo send 10 s, toast texts, Undo removes the task and restores the follow-up (by applying them only when the mail leaves) → T8, T11.
  - Follow-up box (state 6): open only with a lead, choices, working days, zone, 24-hour, fields, buttons, origin, lead next follow-up date + task time, lead panel shows the task's date and time → T2, T4, T8, T11.
  - Tasks priority and note, High badge and muted note line → T1, T2, T4.
  - Lead page uses the same send path → T15.
  - View-only rule server-enforced on every new route → T6, T7, T8 (tests), T12/T14 (screen).
  - Parity screenshots, runbook, PENDING → T16, T17.
- **Types:** `DraftCreate`, `DraftSave`, `DraftSend`, `SendFollowUp`, `DraftAttachmentUpload`, `DraftTemplateApply`, `SignatureUpdate`, `UNDO_SEND_SECONDS`, `sendFollowUpChoices`, `schedulePresets`, `instantIn`, `addWorkingDays` (T2) are used by T5–T11. `DraftFields`, `GraphDraft`, `createDraft`, `createReplyDraft`, `getDraft`, `updateDraft`, `addAttachment`, `removeAttachment`, `sendDraft` (T3) are used by T6–T8. `openFollowUpTask` (T4) is used by T4 and T8. `DraftError`, `DraftView`, `Recipient`, `saveDraft`, `openDraft` (T6), `queueDraftSend`, `unsend`, `sendNow` (T8) and `DraftFile`/`DraftFileView` (T7) are used by T8, T9, T12–T14. `SendUserEmailPayload.draft`/`followUp` (T8) only by the handler. `useAutoSave`, `useSendDraft`, `useUnsend`, `useSendNow` (T9) by T11–T15. `useSendFlow`, `SendButton`, `useUndoSend` (T11) by T12, T13, T15. `DraftComposer`, `RecipientField`, `InlineReply` (T12) by T13, T14.
- **Review Focus:** line 1 tested in T8, 2 in T8, 3 in T6 and T8, 4 in T8, 5 in T2 and T8.
- **Proportion:** 17 tasks, each with its own test cycle; bodies are left to the implementer except the toolbar order, the copy, and the race-free unsend query, which the spec or the safety argument fixes.
- **Deliberate differences from the mockup / calls to flag at hand-over:** see "Decisions I made" 12, 13, 14, 19 and 20; the mockup's React (smile) button stays out (release 2 ruling).

## Decisions I made

1. **Schedule send and Undo send run on the CRM job queue, not Graph deferred send.** Why: Undo, Edit, Send now and Cancel need the mail to be under the CRM's control until it leaves; with Graph deferred send (`PidTagDeferredSendTime`, possible with Mail.ReadWrite) the message waits in Exchange's Outbox, where Graph cannot reliably edit or cancel it, and the follow-up must be filed when the mail actually leaves. The job row and the CRM row are in Postgres, so a restart keeps them; an interrupted send is failed, never resent. Cost if wrong: if the worker is down at the scheduled time, the mail leaves when it is back (late, not lost); in Outlook a scheduled mail looks like an ordinary draft.
2. **Every message being written is an Outlook draft** (createDraft / createReply / createReplyAll / createForward, PATCH to save, `/send` to send). Why: the spec wants drafts in Outlook Drafts; createReply keeps Outlook threading and a forward keeps the original's attachments; files go straight onto the draft, so the CRM stores no user files. Cost if wrong: one more set of Graph writes that only fakes have met (the runbook's live check covers them; rollback to `70ec558` is clean because the migration only adds columns).
3. **The lead effects happen when the mail leaves, not on the Send click** (Email sent line, New/Not Contacted → Contacted, follow-up task, lead next follow-up). Undo/Cancel therefore remove nothing: the task never existed and the lead was never changed. Why: restoring "the previous next follow-up" after the fact races with anyone editing the lead in the meantime (seconds for Undo, days for a scheduled send). Cost if wrong: the follow-up task appears in Tasks 10 s after the click (or at the scheduled time); if the owner wants a scheduled mail's task to appear at once, it is a small change in `send.ts`.
4. **The follow-up box also opens for a scheduled send, and its presets count from the scheduled day.** Why: "In 3 working days" counted from today could fall before the mail goes out. Cost if wrong: one line (base day = today).
5. **The box opens only for an open lead the sender can see**; closed or restricted leads get a plain send. Why: release 2's `setLeadFollowUp` refuses closed leads (`lead_closed`) and closing a lead closes its tasks. Cost if wrong: a follow-up on a closed lead must be added with Create task.
6. **An email follow-up task on the same day as the lead's next follow-up stands in for the lead follow-up task** (no second "Follow up · company" task; ticking it done clears the lead's date). Why: with "Also update the lead's next follow-up" ticked the user would otherwise get two tasks for one follow-up. Cost if wrong: `syncFollowUpTask`, the task edit mirror, the lead panel and `setLeadFollowUp` all go through `openFollowUpTask`; reverting is local to `leads/service.ts`.
7. **Attachments from the CRM: one file at most 2.5 MB, types `sniff()` knows (PDF, pictures, Office), at most 20, uploaded straight to the Outlook draft; no Graph upload sessions.** Why: the same rules and checks as template files, and a single Graph request stays under its 4 MB limit. Cost if wrong: zip, CSV or larger files must be attached in Outlook (the error says so).
8. **Inline pictures are inline attachments of the draft with a content-id**, shown in the editor as data URLs and sent as `cid:`. Why: data: pictures exceed the 200 000-character body cap and are blocked by Gmail and others. Cost if wrong: more moving parts than embedding (tested in T7/T10).
9. **The folded quote is the body Graph gives the reply draft, kept sanitised in `quoted_html` and appended on every save; the user edits only their own part.** Drafts made in Outlook open whole (no fold). Why: the quote then looks exactly like Outlook's. Cost if wrong: a very long original is quoted as plain text (over 200 000 characters).
10. **`send_user_email` gets its own worker lane.** Why: a running mailbox sync or backfill job (up to ~20 s, longer for big syncs) would otherwise hold an Undo-window or scheduled send behind it. Cost if wrong: one more concurrent Graph caller in the worker.
11. **Untouched drafts are deleted when the editor closes** (Reply clicked, nothing typed, then left); touched ones stay in Drafts, as Outlook does. Why: no clutter in users' Outlook Drafts. Cost if wrong: one rule in `DraftComposer`.
12. **The lead page keeps its own form layout**; only its send path changes (draft at Send, follow-up box, Schedule send, Undo). `POST /leads/:id/emails` and the "follow-up in N days" choice are removed. Why: spec "one implementation" is about the send path; the lead page form is prototype-approved. Cost if wrong: if the owner wants the inline editor on the lead page too, it can mount `DraftComposer`.
13. **New message keeps a Project field (release 3B tagging) when relevant and drops the old Client picker** (the Lead picker replaces it; `?company=` narrows it). Deliberate addition to the mockup. Why: Projects-list Email buttons and project tagging must keep working. Cost if wrong: hide the field.
14. **Priority and Note are also editable in the task dialog**, not only shown. Why: a note added from the follow-up box should be correctable. Cost if wrong: two fields to remove.
15. **Editing the same draft in Outlook and the CRM at the same time: the last save wins**; drafts made in Outlook are read fresh from Graph when opened in the CRM. Why: no merge exists in Outlook either. Cost if wrong: an edit made in Outlook to a CRM-made draft while it is open in the CRM is overwritten on the next auto-save.
16. **Signature is stored on the user (`signature_html`, `signature_auto`), formatting and links only, no pictures, at most 20 000 characters.** Why: one per user (spec), and pictures would need the inline-file machinery on every message. Cost if wrong: a logo in the signature needs a later change.
17. **Scheduled "Cancel" moves the message back to Drafts (not deleted); Edit = Cancel + open the editor.** Why: Outlook does the same; nothing written is lost. Cost if wrong: the user deletes it from Drafts.
18. **A failed draft send stays in Drafts marked Failed, with a notification to the sender.** Why: a scheduled send can fail hours later with nobody watching. Cost if wrong: one notification per failure.
19. **The Schedule send popover shows the mockup's "Recipient's time" line** from `resolveTimezones` of the lead's company, only when that gives one zone different from the sender's. Cost if wrong: hide the line.
20. **A message being sent stays in folder `drafts` until it leaves** (status `queued`), the Drafts view excludes it and Scheduled lists it. Why: release 1's team-readable rule already excludes drafts, so a team view never shows another user's unsent mail, and sync leaves the row alone while it is queued. Cost if wrong: list view rules only.
