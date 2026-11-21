# Release 2C — Mailer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personalised template emails to ticked leads, sent one by one from the sender's mailbox in the client's working hours.

**Architecture:** `email_campaigns` + `email_campaign_recipients`; shared `resolveTimezones` + `inWorkingHours`; the
worker's per-minute scheduler queues `campaign_step` jobs; `routes/mailer.ts`; web `pages/mailer/*` and the Leads bulk bar.

**Tech Stack:** Fastify 5, Prisma/PostgreSQL, Graph sendMail, React/Vite, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-release-2c-mailer-design.md`

## Global Constraints

- Node 24; `TZ=Europe/London npm test`; e2e after `npm run build`; drift check empty; `npm run i18n:check` clean.
- Working hours Mon–Fri 09:00–18:00 recipient-local; interval 1–15 min; daily limit 200 per mailbox per sender-day; nobody-in-hours recheck 5 min.
- Campaign list: own; Administrators all (list/progress/recipients); actions sender only; never reply content.
- Mailer emails are the sender's private `email_messages` (timeline "Email sent" masked as 2B).

## Review Focus

1. Sender's mailbox disconnected or revoked mid-campaign → Paused with the reason, no further sends, Resume refuses until reconnected.
2. A lead closed / archived / marked Do not email / replied after queueing → Skipped at its turn, no time spent.
3. Two steps for one campaign at once (scheduler twice, slow job) → never two sends in one interval, never one recipient twice.
4. Recipient in a multi-zone country with no city → only sent when working time in all its zones; weekend → waits.
5. Daily limit reached across two campaigns of the same sender → both wait; next day continues.

---

### Task 1: Time zones (shared)
**Files:** `packages/shared/src/timezones.ts` (+ index export), test `packages/shared/test/timezones.test.ts`.
**Produces:** `resolveTimezones(a: { companyTimezone?: string|null; country?: string|null; state?: string|null; city?: string|null }, senderTimezone: string): { zones: string[]; source: 'company'|'address'|'country'|'sender' }`; `inWorkingHours(zones: string[], at: Date): boolean` (Mon–Fri 09:00–<18:00 in every zone).
- [ ] Tests: company tz wins; Chile/Spain/India → one zone 'country'; US + 'Texas'/'TX' → America/Chicago 'address'; US + city 'Seattle' → America/Los_Angeles; US no state/city → all US main zones 'country'; Canada 'Quebec' → America/Toronto; Mexico 'Baja California' → America/Tijuana; Spain 'Las Palmas' → Atlantic/Canary; unknown country → sender; accent/case-insensitive; `inWorkingHours` Saturday false, 17:59 true / 18:00 false, US all-zones window.

### Task 2: Data + rules + Do not email
**Files:** schema + migration `20261129100000_mailer`, `apps/api/src/mailer/rules.ts`, `routes/leads.ts` (do-not-email), `leads/serialize.ts` (doNotEmail, contact.unsubscribedAt), CLI `apps/api/src/cli/fill-company-timezones.ts`, tests `mailerRules.test.ts`, `leads.test.ts`.
**Produces:** `checkRecipients(db, user, leadIds): Promise<RecipientCheck[]>` (`{ leadId, leadNumber, contactId, to, name, company, block: string|null, zones, source }`), `sendBlock(db, user, leadId, sinceDate): Promise<string|null>`; `fillCompanyTimezones(db): Promise<number>`.
- [ ] Tests for each block reason (prototype texts), duplicate address, invisible lead; do-not-email PATCH sets lead + contact, history note, 409 stale; fill sets only empty, single-zone companies.

### Task 3: Campaign API
**Files:** `routes/mailer.ts`, shared `MailerCreate` schema, `routes/navCounts.ts`, tests `mailer.test.ts`.
- [ ] Tests: check returns rows; create needs mailbox (409 no_mailbox), template, lawful basis, valid cc/bcc, ≥1 sendable; Scheduled vs Sending; recipients Queued/Skipped; notification "Mailer queued · …"; list own vs Administrator all; detail 404 for a rep on another's; pause/resume/start/cancel sender only, resume refuses without connected mailbox; nav `mailerLive`.

### Task 4: Worker step + scheduler
**Files:** `jobs/handlers/campaignStep.ts`, `mailer/schedule.ts` (or extend `mail/schedule.ts`), `jobs/types.ts`, `worker.ts`, tests `campaignStep.test.ts`.
- [ ] Tests (fake Graph, fixed clock): sends one, fills merge fields + unsubscribe line, cc/bcc, stores email_message (campaign id, bcc) + masked history + Contacted, next_send_at = +interval; skip reasons cost no time; replied → Skipped; outside hours → waits (wait_reason) and recipients in hours go first; daily limit across campaigns → wait to next day; auth failure → Paused + mailbox error; disconnected → Paused; other failure → Failed; interrupted Sending → Failed; last → Completed + notification; scheduler: Scheduled→Sending at start, one step job per due campaign, none duplicated; concurrent steps lock (FOR UPDATE) so one sends.

### Task 5: Web
**Files:** `api/mailer.ts`, `pages/mailer/{MailerPage,CampaignPage,MailerWizard}.tsx`, Leads bulk bar, Sidebar, router, EditProfileModal + ProfileCard (Do not email), CSS, locales, tests `mailerWizard.test.tsx`, `campaignPage.test.tsx`.
- [ ] Tests: wizard 4 steps, preview, cc/bcc validation, review skipped rows + local time column, lawful basis required, posts body; campaign page tiles, actions per status, cancel confirm; Mailer page gate note.

### Task 6: e2e, seed, docs
**Files:** `e2e/mailer.spec.ts`, seed (a template), README, checklist, PENDING if needed.
- [ ] e2e: Neha ticks two leads → wizard → queued → campaign page (Queued/Skipped); Maya (Admin) sees it in the list; Arjun (rep) does not. Full build + suite green.
