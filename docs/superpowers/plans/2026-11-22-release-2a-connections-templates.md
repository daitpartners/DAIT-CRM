# Release 2A — Personal Mailboxes and Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each user connects their own Microsoft 365 mailbox in Settings; the team keeps an email-template library (written or `.oft`) that the lead page's Email tab offers.

**Architecture:** Personal mailboxes are `email_accounts` rows with `kind='personal'`, stored by the existing encrypted Microsoft connect flow in a new `personal` mode. Templates are a new `email_templates` table with a small CRUD API. The web app gets the prototype's two Settings cards, a browser `.oft` parser ported from `prototype/js/oft.js`, and template filling in `EmailForm`.

**Tech Stack:** Fastify 5 + Prisma/PostgreSQL (apps/api), React/Vite + TanStack Query (apps/web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-release-2a-connections-templates-design.md`

## Global Constraints

- Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`); run the full suite with `TZ=Europe/London npm test`.
- Tokens are only ever stored via `encrypt()` and never returned by the API or written to logs/audit (`accountSummary`).
- Every visible phrase through `t()` with es/fr entries (`npm run i18n:check`).
- Microsoft 365 only; "Other provider" choices Google Workspace and IMAP show "Coming later".
- Unbuilt-in-2A copy, exactly: "Mail sync arrives with the Email screen (part 2B)".

## Review Focus

- A user connects a different Microsoft account than their CRM login (e.g. a colleague's): the mailbox is stored on the user who started the connect, address from Graph — test that the row's `userId` is the starter (Task 2).
- Reconnecting replaces the user's personal row instead of adding a second one (Task 2 test).
- Deepak's personal mailbox has the same address as the system mailbox: both rows coexist and disconnecting one leaves the other (Task 1/2 test).
- A sales rep cannot see or change another user's mailbox (`GET /mailboxes` `all` absent; `PATCH`/`disconnect` 404) (Task 2 test).
- A stale template edit (old `updatedAt`) is refused with 409 `stale` (Task 3 test).

---

### Task 1: Migration — personal mailbox fields, `(address, kind)` key, `email_templates`

**Files:** Modify `prisma/schema.prisma`; Create `prisma/migrations/20261125100000_release_2a/migration.sql`; Modify `apps/api/src/graph/accounts.ts` (system upsert uses the compound key `address_kind`).
**Produces:** `EmailAccount` fields `syncMail Boolean @default(true) @map("sync_mail")`, `syncCalendar Boolean @default(false) @map("sync_calendar")`, `sharedMailboxes String[] @default([]) @map("shared_mailboxes")`, `lastSyncAt DateTime? @map("last_sync_at")`, `messageCount Int @default(0) @map("message_count")`, `@@unique([address, kind])` (drop `address @unique`); model `EmailTemplate` (`email_templates`: `id, name, language, subject, body, sourceType @map("source_type"), fileName?, fileSize?, createdById?, createdAt, updatedAt`; `createdBy User? onDelete SetNull`).

- [ ] Step 1: Existing tests in `apps/api/test/mailboxes.test.ts` that connect the system mailbox must still pass after the key change; add a test there: storing a personal row (`prisma.emailAccount.create({ kind: 'personal', address: <system address> … })`) next to the system row succeeds.
- [ ] Step 2: Run it → FAIL (unique violation on `address`).
- [ ] Step 3: Schema + migration (`ALTER TABLE … DROP CONSTRAINT/INDEX email_accounts_address_key; CREATE UNIQUE INDEX email_accounts_address_kind_key ON email_accounts(address, kind)`; add columns; `CREATE TABLE email_templates`), `npx prisma migrate dev` on the unit DB, update `connectSystemMailbox` to `findUnique/upsert({ where: { address_kind: { address, kind: 'system' } } })`.
- [ ] Step 4: `cd apps/api && npx vitest run test/mailboxes.test.ts test/sendEmail.test.ts` → PASS.
- [ ] Step 5: Commit `feat(db): personal mailbox fields and email_templates`.

### Task 2: Personal mailbox API and connect mode

**Files:** Modify `apps/api/src/graph/accounts.ts` (add `connectPersonalMailbox`), `apps/api/src/auth/microsoft.ts` (`getConnectUrl` mode union `'system' | 'personal'`), `apps/api/src/routes/auth.ts` (`mode=personal` start + callback branch, redirects `/settings/connections?connected=1` / `?error=connect-failed`), `apps/api/src/routes/mailboxes.ts` (`GET /mailboxes`, `PATCH /mailboxes/:id`, `POST /mailboxes/:id/disconnect`); Modify `packages/shared` schemas: `MailboxOptions = z.object({ syncMail: z.boolean(), syncCalendar: z.boolean(), sharedMailboxes: z.array(z.string().trim().toLowerCase().email()).max(10) }).partial()`.
**Produces:** `connectPersonalMailbox({ userId, address, refreshToken, tokenExpiresAt? }): Promise<EmailAccount>` (upserts the user's single personal row; an older personal row of the same user with another address is deleted; audit). API view `MailboxView = { id, address, userId, userName, provider, status, syncMail, syncCalendar, sharedMailboxes, lastSyncAt, messageCount }`. `GET /mailboxes` → `{ mine: MailboxView | null, all?: MailboxView[] }`.

- [ ] Step 1: Tests in `apps/api/test/personalMailbox.test.ts`: (a) `connectPersonalMailbox` twice for one user with two addresses → one row, second address, token decrypts to the second token; (b) personal row with the system address coexists with the system row; (c) `GET /mailboxes` as rep → `{ mine }` only, as admin → `all` lists every personal row with `userName`; (d) `PATCH` own row `{ syncCalendar: true, sharedMailboxes: ['hello@daitpartners.com'] }` → saved, invalid address → 400; rep `PATCH`/`disconnect` of another user's row → 404; (e) `disconnect` → status `disconnected`, `refreshTokenEnc` emptied, system row untouched; (f) `GET /auth/microsoft/connect?mode=personal` signed in → 302 to the fake client's connect URL and state cookie `mode: 'personal'`; callback with the fake identity stores the row on the starting user and redirects to `/settings/connections?connected=1`. Responses never contain `refreshTokenEnc`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement (reuse `pkce()`, `setStateCookie`, `CONNECT_SCOPES`; any signed-in user may connect their own mailbox).
- [ ] Step 4: `npx vitest run test/personalMailbox.test.ts test/auth.test.ts test/mailboxes.test.ts` → PASS.
- [ ] Step 5: Commit `feat(api): personal mailbox connect, list, options, disconnect`.

### Task 3: Email templates API

**Files:** Create `apps/api/src/routes/emailTemplates.ts` (register in `app.ts`); shared schemas `EmailTemplateInput = { name: 1..150, language: 'en'|'es'|'fr', subject: 1..500, body: 0..20000, sourceType: 'manual'|'oft', fileName?: ≤255, fileSize?: int ≥0 }`, update = partial + `updatedAt`.
**Produces:** `GET /email-templates` (signed in) → `{ items: TemplateView[] }` with `TemplateView = { id, name, language, subject, body, sourceType, fileName, fileSize, createdBy: { id, name } | null, createdAt, updatedAt }`, ordered: the user's language first, then language, then name; `POST` / `PATCH /:id` / `DELETE /:id` (`manage_leads`), 409 `stale` on an old `updatedAt`, audit `email_template`.

- [ ] Step 1: Tests `apps/api/test/emailTemplates.test.ts`: create two (en, es) as a rep → list for an es user starts with the es one; patch with the loaded `updatedAt` → 200, with an old one → 409 `stale`; delete → gone; 401 signed out; a user without `manage_leads` gets 403 on POST.
- [ ] Step 2: Run → FAIL. - [ ] Step 3: Implement. - [ ] Step 4: Run → PASS. - [ ] Step 5: Commit `feat(api): email templates`.

### Task 4: Settings → Email & calendar connections card

**Files:** Rewrite `apps/web/src/pages/settings/Connections.tsx` (prototype `V.connectionsCard`), Create `apps/web/src/api/mailboxes.ts` (`useMailboxes`, `useSaveMailboxOptions`, `useDisconnectMailbox`), `apps/web/src/pages/settings/MailboxOptionsModal.tsx`, `apps/web/src/pages/settings/ConnectProviderModal.tsx`; keep `SystemMailbox` for admins under the card.
**Consumes:** Task 2 API.

- [ ] Step 1: e2e `apps/web/e2e/settings.spec.ts` (or a new `connections.spec.ts`): as Maya with no personal row → heading "Email & calendar connections", the subtitle, buttons "Connect Microsoft 365" (href `/api/auth/microsoft/connect?mode=personal`) and "Other provider", note "Your mailbox is not connected." ; Other provider → dialog "Connect a mailbox" with Microsoft 365 / Outlook, Google Workspace / Gmail ("Coming later", disabled), Other (IMAP / SMTP) ("Coming later", disabled). Seed a personal row through the e2e seed (or a test-only insert) → row shows the address, "Microsoft 365", "Connected", "synced never", "0 messages", buttons Sync now (toast "Mail sync arrives with the Email screen (part 2B)"), Options (dialog saves Sync calendar), Disconnect (confirm → row gone, Connect button back).
- [ ] Step 2: Run → FAIL. - [ ] Step 3: Implement; parity capture `connections`. - [ ] Step 4: Run → PASS. - [ ] Step 5: Commit `feat(web): Email & calendar connections card`.

### Task 5: Settings → Email templates card and `.oft` reader

**Files:** Create `apps/web/src/lib/oft.ts` (`parseOft(buf: ArrayBuffer): { subject: string; body: string; html: string }`, a TypeScript port of `prototype/js/oft.js`), `apps/web/src/api/templates.ts`, `apps/web/src/pages/settings/Templates.tsx` (replaces the placeholder), `apps/web/src/pages/settings/TemplateModal.tsx`; unit test `apps/web/test/oft.test.ts`.

- [ ] Step 1: Unit: `parseOft(readFileSync('docs/sample-template.oft'))` returns a non-empty subject and body (assert the exact subject read from the file); a non-OLE buffer throws "Not an Outlook template (.oft/.msg) file". e2e: Write a template (Name, Language, Subject with `{first_name}`, Body) → row with "Written here", language, subject, "Maya Pillai · date"; Upload `.oft` (setInputFiles with the sample) → editor prefilled with the file's subject, Save → row "Outlook .oft" with file name · size; Edit → change subject; Delete → confirm → gone; footer help text present.
- [ ] Step 2: Run → FAIL. - [ ] Step 3: Implement; parity capture `templates`. - [ ] Step 4: Run → PASS. - [ ] Step 5: Commit `feat(web): email templates card with .oft upload`.

### Task 6: Lead page Email tab uses templates

**Files:** Modify `apps/web/src/pages/leads/EmailForm.tsx`; unit test `apps/web/test/emailTemplateFill.test.ts` for `fillTemplate(text: string, ctx: { firstName: string; company: string; me: string; leadNumber: string }): string` (export from `apps/web/src/lib/mergeFields.ts`).

- [ ] Step 1: Unit: `fillTemplate('Hi {first_name} at {company}, {me} ({lead_id}) {quote_no}', …)` → `'Hi Priya at Northwind, Maya Pillai (LD-1004) '`; unknown `{x}` left as is. e2e (lead-page parity): with a template "Follow-up" (en) and one (es), the Template select lists "— blank —", "Follow-up", then the es one with "(ES)"; picking "Follow-up" fills Subject and Message with the merge fields replaced.
- [ ] Step 2: Run → FAIL. - [ ] Step 3: Implement. - [ ] Step 4: Run → PASS. - [ ] Step 5: Commit `feat(web): Email tab template list and merge fields`.

### Task 7: Docs and verification

- [ ] Update `docs/RELEASE-PARITY-CHECKLIST.md` (Settings: connections + templates as built) and `README.md` modules list; full `TZ=Europe/London npm test` green; whole-branch review; commit `docs: release 2A`.
