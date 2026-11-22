# Mail follow-ups (2B-2 + 2C review items) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the release 2B-2 and 2C review follow-ups listed in `docs/PENDING.md` so the live Email screen and Mailer behave as designed.

**Architecture:** Small, independent fixes in the existing modules: `apps/api/src/mail/*`, `routes/mail.ts`, `jobs/handlers/syncMailbox.ts`, `mailer/*`, `jobs/handlers/campaignStep.ts`, `routes/mailer.ts`, `routes/leads.ts`, `packages/shared/src/timezones.ts`, web `pages/email/*`, `pages/mailer/*`, `pages/leads/*`. One migration (campaign language).

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, Graph, React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/PENDING.md` sections "Release 2B-2 follow-ups" and "Release 2C (Mailer) follow-ups"; designs `docs/superpowers/specs/2026-11-22-release-2b2-sync-email-screen-design.md`, `docs/superpowers/specs/2026-11-22-release-2c-mailer-design.md`; prototype `prototype/js/views-work.js` (V.email), `prototype/js/views-mailer.js`, `prototype/js/ui.js` (`rel`, `fmtDT`).

**Not changed (match the prototype — owner rule "build only what the prototype shows"):** Email-screen Templates list filling to six with other languages and the wizard listing every template (prototype `templatesFor` = own language first, then the rest); no Do not email on a lead without a contact; campaign page lead link (the lead page already opens on its Email tab, the default tab). Record these as "matches prototype" in `docs/PENDING.md`.

## Global Constraints

- Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`); `TZ=Europe/London npm test` from the repo root; e2e after `npm run build`; Prisma drift check empty; `npm run i18n:check` clean (every new UI string in en/es/fr).
- Privacy (owner, 22 Nov 2026): mail belongs to its mailbox owner, administrators included; nothing here may expose another user's mail, a sender, a subject or a body to someone else.
- Working hours Mon–Fri 09:00–<18:00 recipient-local; daily limit `MAILER_DAILY_LIMIT` (200) per sender-day in the sender's time zone.
- No new npm dependencies.
- Never push; never deploy without the owner saying "deploy".
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A conversation linked to a lead the user can no longer see (transferred away) → new mail in it is stored without that lead; the list, reader and smart views never show its number.
2. Sender's day boundary on a DST change day (America/Santiago, Australia/Sydney, Europe/London) → the 200 count resets exactly at local midnight (or the first existing instant after it).
3. Contact unsubscribed via lead A, viewed on lead B → B shows Do not email ticked; unticking on B lets the mailer email B again; A stays blocked by its own flag.
4. Campaign waiting over a weekend for recipients in several zones → next step is queued for the earliest Monday 09:00 among them, not every 5 minutes, and never in the past.
5. Opening an unread message → its list row and the Inbox count lose bold/unread at once, without waiting for the next poll.

---

### Task 1: Mail matching, list and reply (API)

**Files:** Modify `apps/api/src/mail/match.ts`, `apps/api/src/routes/mail.ts`; Test `apps/api/test/mailMatch.test.ts`, `apps/api/test/mail.test.ts`.

**Interfaces:** Produces nothing new; `matchMail` keeps its signature.

- [ ] **Step 1: Failing tests**
  - `mailMatch.test.ts` › `thread link to a lead the user cannot see keeps company and contact but no lead`: user A's message in thread T linked to lead L; L transferred to user B (A is a Sales Representative without `view_all_leads`); `matchMail(db, A, { threadId: T, ... })` → `{ leadId: null, contactId: <same>, companyId: <same> }`.
  - `mail.test.ts` › `list hides the number of a lead the user can no longer see`: message row with `leadId` of a lead now hidden from the caller → GET `/api/mail?view=inbox` item has `leadId: null, leadNumber: null`; GET `/api/mail?view=unlinked` includes it.
  - `mail.test.ts` › `awaiting reply finds an old message when filtered by company`: 205 awaiting messages for company X newer than one for company Y → `?view=awaiting&company=Y` returns the Y message.
  - `mail.test.ts` › `reply surfaces a database error instead of sending without the lead`: stub `lockLeads` (or the tx) to throw a non-NotFound error → POST `/mail/:id/reply` responds 500 and no `email_messages` row is created.
- [ ] **Step 2:** Run `TZ=Europe/London npx vitest run apps/api/test/mailMatch.test.ts apps/api/test/mail.test.ts` (from `apps/api`) — new tests FAIL.
- [ ] **Step 3: Implement**
  - `matchMail`: thread hit → if `linked.leadId` and `!(await canSeeLead(db, user, linked.leadId))`, return `{ ...linked, leadId: null }`.
  - GET `/mail`: after `findMany`, one query for the visible subset of the rows' lead ids (`leadWhere(user, { includeArchived: true })`); `listItem` gets `leadId`/`leadNumber` null for the rest. The `unlinked` view also includes rows whose lead is not visible (`OR: [{ leadId: null }, { lead: { NOT: leadWhere(user, { includeArchived: true }) } }]`, drafts still excluded); `/mail/meta` `unlinked` count uses the same condition.
  - `awaitingIds`: drop `LIMIT ${LIST_MAX}` (the list query's `take` caps the result after filters); keep an upper bound of 5000.
  - Reply route: replace `.catch(() => null)` with a catch that returns null only for `NotFoundError` and rethrows anything else.
- [ ] **Step 4:** Same command — PASS; then full `apps/api` suite green.
- [ ] **Step 5: Commit** `fix(mail): hidden leads never shown through a conversation; awaiting reply filters before the cap; reply does not swallow database errors`

### Task 2: Mail sync housekeeping (worker)

**Files:** Modify `apps/api/src/jobs/handlers/syncMailbox.ts`, `apps/api/src/mail/schedule.ts`, `apps/api/src/jobs/queue.ts`, `apps/api/src/worker.ts`; Test `apps/api/test/syncMailbox.test.ts`, `apps/api/test/jobs.test.ts`.

**Interfaces:** Produces `pruneJobs(db: Db, now?: Date): Promise<number>` in `jobs/queue.ts`, constants `DONE_KEEP_DAYS = 7`, `FAILED_KEEP_DAYS = 30`.

- [ ] **Step 1: Failing tests**
  - `syncMailbox.test.ts` › `a draft sent from Outlook becomes sent`: existing row `status: 'draft', folder: 'drafts'`; delta page returns the same graph id with `isDraft: false`, folder sent, `sentAt` S → row `status: 'sent'`, `folder: 'sent'`, `occurredAt: S`.
  - `syncMailbox.test.ts` › `message count counts only the current owner's mail`: account re-assigned from user 1 to user 2 with 3 rows of user 1 and 2 of user 2 → after a run `messageCount === 2`.
  - `syncMailbox.test.ts` (or `mailSchedule`) › `no sync is queued for a deactivated user's mailbox`: connected account whose user `isActive: false` → `scheduleMailSync()` returns 0.
  - `jobs.test.ts` › `pruneJobs removes old finished jobs only`: done 8 days old (gone), done 6 days old (kept), failed 31 days (gone), failed 29 days (kept), queued 40 days (kept), running (kept) → returns 2.
- [ ] **Step 2:** Run the two files — new tests FAIL.
- [ ] **Step 3: Implement**
  - `storeMessage` existing branch: when `existing.status === 'draft' && !m.isDraft`, also set `status: outbound ? 'sent' : 'received'` and `occurredAt` as for a new row.
  - Message count: `count({ where: { accountId: account.id, userId: user.id } })`.
  - `scheduleMailSync`: filter accounts to active users (`user: { isActive: true }` via the EmailAccount → User relation).
  - `pruneJobs`: `deleteMany` of `status: 'done'` with `updatedAt < now − 7 d` and `status: 'failed'` with `updatedAt < now − 30 d`. `worker.ts`: call it at start and every hour (`setInterval`, cleared in `finally`), errors through `warn('job cleanup')`.
- [ ] **Step 4:** PASS; full `apps/api` suite green.
- [ ] **Step 5: Commit** `fix(sync): drafts sent from Outlook become Sent; per-owner message count; no sync for deactivated users; old job rows cleaned up`

### Task 3: Email screen (web)

**Files:** Modify `apps/web/src/hooks/useFormatDate.ts`, `apps/web/src/pages/email/EmailPage.tsx`, `apps/web/src/pages/email/Reader.tsx`, `apps/web/src/pages/email/ComposeModal.tsx`, `apps/web/src/pages/email/LinkLeadModal.tsx`, `apps/web/src/api/mail.ts`, i18n catalogs; Test `apps/web/test/emailPage.test.tsx`, `apps/web/e2e/email.spec.ts`.

**Interfaces:** Produces `relative(iso: string): string` from `useFormatDate()` — prototype `rel`: `Today, HH:mm` / `Yesterday, HH:mm` (translated words) / `<date>, HH:mm`, in the user's time zone, 24-hour.

- [ ] **Step 1: Failing tests** (`emailPage.test.tsx`, fake clock 2026-11-22 12:00 Europe/London user)
  - `list row shows time of day for today` → row for 2026-11-22T09:05Z shows `Today, 09:05`; 2026-11-21T17:00Z shows `Yesterday, 17:00`; 2026-11-01T08:00Z shows the user's date format + `, 08:00`.
  - `synced line shows a relative time` → `synced Today, 11:55`.
  - `opening an unread message clears its bold at once`: list with unread message 7, open it (non-peek) → row loses `unread` class and Inbox count drops by 1 before any list refetch.
  - `compose lead option shows translated status and source` (language es): option text uses `leadStatusText` / `lookupText('lead_source', …)`; contact line uses `lookupText('contact_type', …)`.
  - `link modal keeps the chosen lead when the search hides it`: choose lead LD-1 then type a search that excludes it → Link posts `link` with LD-1's id (not `create-lead`); the select still shows LD-1.
- [ ] **Step 2:** `npx vitest run test/emailPage.test.tsx` (from `apps/web`) — FAIL.
- [ ] **Step 3: Implement**
  - `relative` in `useFormatDate` using the shared formatters; use it for list row time, reader thread history, the "synced …" line; the reader header shows `dateTime` (prototype `fmtDT`).
  - After GET `/mail/:id` without peek returns a message that was unread in the cached list, update every cached `mail list` query with `setQueryData` (`isRead: true`) and invalidate `mail meta` (match the query keys in `api/mail.ts`).
  - Compose: translated status / source / contact type with the existing label helpers used on the lead page (`leadStatusText`, the `lookup`/`lookupText` helper).
  - LinkLeadModal: keep the chosen lead object in state; render it as an option even when absent from search results; `go()` uses the stored lead.
- [ ] **Step 4:** PASS; `npm run i18n:check`; `email.spec.ts` still green.
- [ ] **Step 5: Commit** `fix(web): Email shows times of day, clears unread at once, translated compose labels, Link keeps the chosen lead`

### Task 4: Time zones and day boundaries (shared + mailer schedule)

**Files:** Modify `packages/shared/src/timezones.ts`, `apps/api/src/mailer/schedule.ts`; Test `packages/shared/test/timezones.test.ts`, `apps/api/test/campaignStep.test.ts` (or a new `apps/api/test/mailerSchedule.test.ts`).

**Interfaces:** Produces `nextWorkingStart(zones: string[], from: Date): Date` (shared, exported from the index): the earliest instant ≥ `from` at which `inWorkingHours(zones, t)` is true; searches 15-minute steps up to 8 days, then returns `from + 5 min` as a fallback. `startOfDayIn` / `startOfNextDayIn` keep their signatures.

- [ ] **Step 1: Failing tests**
  - `startOfDayIn('America/Santiago', 2026-09-06T12:00Z)` = the first instant of 6 Sep in Santiago (DST starts that night: local 00:00 does not exist → `2026-09-06T04:00Z`, i.e. 01:00 −03); `startOfDayIn('America/Santiago', 2026-04-05T12:00Z)` = `2026-04-05T04:00Z` (clocks went back at 03:00Z; 00:00 −04); `startOfDayIn('Australia/Sydney', 2026-10-04T05:00Z)` = `2026-10-03T14:00Z`; `startOfDayIn('Australia/Sydney', 2026-04-05T05:00Z)` = `2026-04-04T13:00Z`; `startOfDayIn('Europe/London', 2026-03-29T12:00Z)` = `2026-03-29T00:00Z`. (Instants verified with `Intl` on 22 Nov 2026.) For each, also assert the result's local date equals the input's local date and `result − 1 ms` is the previous local date; same for `startOfNextDayIn` on the day before each change.
  - `nextWorkingStart(['America/Chicago'], Saturday 2026-11-21T20:00Z)` = Monday `2026-11-23T15:00Z`; inside hours returns `from`; `['Asia/Kolkata']` Friday 13:00Z → Monday 03:30Z; all US zones Saturday → Monday 17:00Z (09:00 Los Angeles, when all are open).
  - Mexico: `resolveTimezones({ country: 'Mexico', state: 'Jalisco' }, 'UTC')` → `['America/Mexico_City']` source `address`; `'Nuevo León'` → `America/Monterrey`; `'Yucatán'` → `America/Merida`. Brazil: `'São Paulo'`/`'SP'` → `America/Sao_Paulo`; `'Bahia'` → `America/Bahia`; `'Pernambuco'` → `America/Recife`; `'Pará'` → `America/Belem`.
- [ ] **Step 2:** Run both test files — FAIL.
- [ ] **Step 3: Implement**
  - `startOfDayIn`: target local date from `at`; guess `t = midnightLocal − offset(at)`; refine `t = midnightLocal − offset(t)` up to 3 times until `offset` is stable; if the local date of `t` is before the target (midnight in a DST gap), advance to the first instant whose local date is the target (step by the offset difference).
  - MX states → zones (added to `MX_STATES`; existing entries unchanged): Coahuila, Durango, Nuevo León, Tamaulipas → `America/Monterrey`; Campeche, Yucatán → `America/Merida`; Aguascalientes, Chiapas, Ciudad de México/CDMX, Colima, Estado de México/México, Guanajuato, Guerrero, Hidalgo, Jalisco, Michoacán, Morelos, Oaxaca, Puebla, Querétaro, San Luis Potosí, Tabasco, Tlaxcala, Veracruz, Zacatecas → `America/Mexico_City`. BR states: SP, RJ, MG, ES, PR, SC, RS, GO, DF → `America/Sao_Paulo`; BA → `America/Bahia`; PE → `America/Recife`; AL, SE → `America/Maceio`; CE, MA, PI, RN, PB → `America/Fortaleza`; PA, AP → `America/Belem`; TO → `America/Araguaina`. Full names and abbreviations, accent-insensitive like the existing tables.
- [ ] **Step 4:** PASS; shared + api suites green.
- [ ] **Step 5: Commit** `fix(timezones): day boundary exact on daylight-saving days; next working time; all Mexican and Brazilian states`

### Task 5: Mailer step (worker) + campaign language

**Files:** Modify `prisma/schema.prisma` + migration `prisma/migrations/20261130100000_campaign_language/migration.sql`, `apps/api/src/jobs/handlers/campaignStep.ts`, `apps/api/src/routes/mailer.ts` (create), `apps/api/src/mailer/rules.ts`; Test `apps/api/test/campaignStep.test.ts`, `apps/api/test/mailerRules.test.ts`.

**Interfaces:** Consumes `nextWorkingStart` (Task 4). Produces `EmailCampaign.language String @default("en") @db.VarChar(5)` (`language` column), set from the template at create.

- [ ] **Step 1: Failing tests**
  - `campaignStep` › `over a weekend the next step waits for Monday`: working-hours-only campaign, recipients in America/Chicago and Asia/Kolkata, now Saturday 12:00Z → `waitReason: 'working_hours'`, `nextSendAt` = `nextWorkingStart` minimum (Monday 03:30Z), never < now.
  - `campaignStep` › `deleted template keeps the campaign's language for the opt-out line`: campaign created from an `es` template, template deleted → sent text ends with the Spanish line.
  - `campaignStep` › `a mailbox put in error by sync pauses with "needs reconnecting"`: sender's account `status: 'error'` → `pauseReason: 'Mailbox needs reconnecting'`; no account at all → `'Mailbox disconnected'`.
  - `campaignStep` › `two steps at once send one email`: two queued `campaign_step` jobs for one due campaign with 2 recipients, run both handlers with `Promise.all` → exactly one `sendMail` call, one recipient Sent, the other Queued.
  - `mailerRules` › `company with only a country uses the lead's city`: company `{ country: 'United States', state: null, city: null, timezone: null }`, lead city `Seattle` → zones `['America/Los_Angeles']`, source `address`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement**
  - Migration: `ALTER TABLE email_campaigns ADD COLUMN language VARCHAR(5) NOT NULL DEFAULT 'en'; UPDATE email_campaigns c SET language = t.language FROM email_templates t WHERE c.template_id = t.id;` (match real table/column names in the schema). Create route sets `language: template.language`; the step uses `c.language` (drop the template lookup).
  - Waiting: collect `nextWorkingStart(r.timezones, now)` for the recipients skipped for hours; `nextSendAt = max(now + 60 s, min(...))`.
  - No connected account: if an account for the sender exists with `status: 'error'`, pause with `'Mailbox needs reconnecting'` and the reconnect notification text already used; else the current `'Mailbox disconnected'`.
  - `checkRecipients`: when the company has no timezone, state or city, pass `{ country: company.country ?? lead.country, state: null, city: lead.city }`.
- [ ] **Step 4:** PASS; drift check empty; api suite green.
- [ ] **Step 5: Commit** `fix(mailer): weekend waits jump to the next working time; campaign keeps its language; reconnect reason; lead city used when the company has none`

### Task 6: Mailer list and campaign detail (API)

**Files:** Modify `apps/api/src/routes/mailer.ts`; Test `apps/api/test/mailer.test.ts`.

**Interfaces:** GET `/mailer` items keep their shape (`stats`, `next`, …). GET `/mailer/:id` recipients gain `messageId: string | null` (the internet message id of the recipient's `email_messages` row, filled once the Sent Items copy syncs).

- [ ] **Step 1: Failing tests**
  - `list returns the same stats without loading recipients`: campaign with Queued/Sent/Skipped/Failed recipients and one reply → GET `/mailer` stats equal GET `/mailer/:id` stats (`total, queued, sending, sent, failed, skipped, toSend, replied`) and `next` is the first Queued recipient's name/company.
  - `detail shows the message id once synced`: Sent recipient whose `email_messages.message_id = '<abc@x>'` → recipient `messageId: '<abc@x>'`; Queued → `null`.
- [ ] **Step 2:** Run — FAIL (messageId).
- [ ] **Step 3: Implement** list: one `groupBy` on `email_campaign_recipients` by `campaignId, status` for the page's campaigns; the first Queued per campaign by `position`; replied counts in one SQL query (a Sent recipient whose lead has a `received` message in the sender's mail after `sent_at`). Detail: include the recipient's email message `messageId` (via the relation, or one `findMany` by `emailMessageId`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `perf(mailer): campaign list counts in the database; recipients show the message id`

### Task 7: Do not email follows the contact (API + web)

**Files:** Modify `apps/api/src/leads/serialize.ts`, `apps/api/src/routes/leads.ts` (do-not-email PATCH), `apps/web/src/pages/leads/ProfileCard.tsx`, `apps/web/src/pages/leads/EditProfileModal.tsx`, web lead type in `apps/web/src/api/leads.ts`; Test `apps/api/test/leads.test.ts`, `apps/web/test/` (profile card test file that covers the badge).

**Interfaces:** Lead detail gains `contactUnsubscribed: boolean` (`contact.unsubscribedAt !== null`). Effective state = `doNotEmail || contactUnsubscribed`.

- [ ] **Step 1: Failing tests**
  - API › `lead shows contactUnsubscribed when its contact unsubscribed through another lead`: leads A and B share contact C; PATCH A `doNotEmail: true` → GET B has `doNotEmail: false, contactUnsubscribed: true`.
  - API › `unticking on the other lead clears the contact's unsubscribe`: then PATCH B `doNotEmail: false` → C `unsubscribedAt: null`, B history note "Do not email removed", A keeps `doNotEmail: true`; `sendBlock` for B → null.
  - Web › badge `Do not email` shows when `contactUnsubscribed` only; Edit profile tick box starts ticked in that case.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** serializer adds `unsubscribedAt` to the contact select and the boolean; PATCH compares the request with the effective state (no-op when equal); `true` sets lead flag + stamps the contact (as today); `false` clears lead flag and the contact's `unsubscribedAt`. Web uses the effective state for the badge and initial tick, and sends the PATCH when the tick differs from it.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `fix(leads): Do not email shows and clears a contact unsubscribed through another lead`

### Task 8: Mailer screens (web)

**Files:** Modify `apps/web/src/pages/mailer/status.tsx`, `apps/web/src/pages/mailer/zones.ts`, `apps/web/src/pages/mailer/CampaignPage.tsx`, `apps/web/src/pages/mailer/MailerPage.tsx`, `apps/web/src/pages/mailer/MailerWizard.tsx`, `apps/web/src/pages/leads/LeadsList.tsx`, `apps/web/src/api/mailer.ts`, i18n catalogs; Test `apps/web/test/mailer.test.tsx`, `apps/web/e2e/mailer.spec.ts`.

**Interfaces:** Consumes recipient `messageId` (Task 6). Produces `pauseReasonText(t: TFn, reason: string | null): string | null` in `status.tsx`; `zoneText(t, zones, now?: Date)`.

- [ ] **Step 1: Failing tests** (`mailer.test.tsx`)
  - `pause reason is translated` (es): `'Paused by Carlos Torres'` → `t('Paused by {name}', { name })`; `'Mailbox disconnected'`, `'Mailbox needs reconnecting'` → their catalog strings; unknown text shown as is.
  - `send via mailer refuses when no ticked lead can be emailed`: check returns all blocked (first block `No email address`) → toast `None of the selected leads can be emailed (no email address, …).` (prototype text, `, …` only when more than one row) and the wizard does not open.
  - `more than 500 ticked leads shows the limit`: 501 ticked → toast `You can send to at most 500 leads in one run.` and no request.
  - `local time shows the current time there`: zones `['America/Chicago']`, now 2026-11-23T15:00Z → `09:00 · America/Chicago`; all-zones rows keep `{country} — all zones`.
  - `campaign page has a Message column`: header `Message`; cell shows `messageId` or `—` (prototype order: Lead, Name, To, Local time, Status, Sent at, Message).
- [ ] **Step 2:** `npx vitest run test/mailer.test.tsx` — FAIL.
- [ ] **Step 3: Implement** LeadsList runs `useMailerCheck` on click (after the 500 guard) and opens the wizard with the result (pass `rows`/`mailbox` in as props so the wizard does not re-check); wizard keeps its own empty-state note for safety. `pauseReasonText` used on MailerPage and CampaignPage. `zoneText` formats the single zone's current `HH:mm` with `Intl.DateTimeFormat` (`hourCycle: 'h23'`). Message column shows `r.messageId` in `.dim`.
- [ ] **Step 4:** PASS; `npm run i18n:check`; `npm run build` then `mailer.spec.ts` green.
- [ ] **Step 5: Commit** `fix(web): Mailer pause reasons translated, refuses an all-blocked selection, local time shows the time, Message column`

### Task 9: Pending list + full verification

**Files:** Modify `docs/PENDING.md`.

- [ ] **Step 1:** Mark each fixed follow-up done (with the commit), and the four "matches prototype" items as kept by design.
- [ ] **Step 2:** From the repo root: `TZ=Europe/London npm test` (all workspaces + e2e after build) and the drift check — all green; note counts.
- [ ] **Step 3: Commit** `docs: mail follow-ups done`
