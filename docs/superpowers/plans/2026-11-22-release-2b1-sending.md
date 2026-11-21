# Release 2B-1 — Sending from the lead page — Implementation Plan

> Executed inline (superpowers:executing-plans). **Spec:** docs/superpowers/specs/2026-11-22-release-2b-email-design.md (2B-1)

## Global Constraints
- Node 24; `TZ=Europe/London npm test`; phrases through `t()` with es/fr; tokens never leave the server.
- Privacy: every email endpoint filters `user_id = caller`; email activity subject only for its sender.

## Review Focus
- An administrator calls `GET /api/leads/:id/emails` on a rep's lead → sees none of the rep's messages (Task 1 test).
- Timeline of a lead viewed by someone else shows "Email sent" without subject; the sender sees the subject (Task 1 test).
- No connected mailbox (or disconnected/error) → 409 `no_mailbox`, nothing queued (Task 1 test).
- Follow-up days on a closed lead do not set a follow-up; on an open lead set today+N in the user's zone (Task 1 test).
- Graph failure on the last attempt marks the message `failed` with the error; earlier failures leave it `queued` (Task 1 test).

### Task 1: API — table, send endpoint, job handler, list, timeline masking
Files: schema + migration `20261127100000_email_messages`; shared `LeadEmailSend`; `apps/api/src/routes/leadEmails.ts` (register); `apps/api/src/jobs/handlers/sendUserEmail.ts` + `jobs/types.ts` + runner registration; `leads/serialize.ts` `activityRow(a, viewerId?)` masking and every caller passing the viewer. Tests `apps/api/test/leadEmails.test.ts`.
Commit `feat(api): send email from a lead through the user's mailbox; own-mail list; private timeline entries`.

### Task 2: Web — Send, mailbox gate, Emails tab
Files: `api/leadEmails.ts`, `EmailForm.tsx` (submit), `FollowUpPanel.tsx` (Emails tab list + count), `Timeline.tsx` if needed. e2e `apps/web/e2e/leadEmail.spec.ts` (Maya has a seeded personal mailbox; sending queues a message that the Emails tab shows as Sending; Arjun without a mailbox sees the connect note).
Commit `feat(web): send email from the lead page; Emails tab`.

### Task 3: Docs, full suite, review, deploy (after owner OK).
