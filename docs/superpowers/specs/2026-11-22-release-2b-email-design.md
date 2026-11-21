# Release 2B — sending, mail sync and the Email screen (design)

Owner, 22 Nov 2026: "go to 2B". Privacy (owner): "others email will not be seen to anyone ie., admin as well. Seba will be
seeing his own mail while client is reply." Timeline (owner chose option A): others see only "Email sent · by {name} ·
{when}"; the sender also sees the subject. Delivery: two deploys (owner took the suggestion). Standing rule: build what
the prototype shows (views-work.js `V.email`, views-lead-detail.js email panel, store.js `sendEmail`).

## Intent

Salespeople email prospects from the CRM through their own Microsoft 365 mailbox, see their replies in the CRM matched to
the lead, and keep their mail private from everyone else, administrators included.

## Approaches

- Delivery: **two deploys (chosen)** — 2B-1 sending + the lead's Emails tab; 2B-2 sync + Email screen — vs one deploy.
- New mail: **poll Graph every 5 minutes from the worker (builder's call)** vs Graph change notifications (webhooks need a
  public endpoint and subscription renewal; not worth it for four mailboxes).

## Privacy rule (both parts)

- An email message belongs to the user whose mailbox it is (`email_messages.user_id`). Every email API returns only the
  caller's own messages. No role reads another user's mail.
- Lead timeline: an `email` activity shows its subject only to its sender; everyone else sees "Email sent" (no subject, no
  body). "Last contact: Email · {when}" stays for everyone.

## 2B-1 (this deploy)

- **Data:** `email_messages` (`id, user_id → users, account_id → email_accounts (set null), lead_id, contact_id,
  company_id (set null), folder ('sent'|'inbox'|'drafts'|'archive'), status ('queued'|'sent'|'failed'), from_address,
  to_addresses jsonb, cc_addresses jsonb, subject varchar(500), body_text, message_id, thread_id, is_read default true,
  occurred_at, last_error, created_at, updated_at`; indexes `(user_id, lead_id)`, `(user_id, folder, occurred_at)`).
- **Send:** `POST /api/leads/:id/emails` `{ to, cc[], subject, body, followUpDays (2|3|7|null), updatedAt }`; needs
  `use_email` and a connected personal mailbox (409 `no_mailbox` otherwise) and a visible, live lead. In one transaction:
  the message row (`sent`/`queued`, contact and company from the lead), a `send_user_email` job, a lead activity
  `email` "Email sent · {subject}" (relatedType `email_message`), and — when `followUpDays` is set and the lead is open —
  next follow-up = today (user's time zone) + days. The worker sends through Graph `sendMail` as the user's mailbox (so it
  is in Outlook Sent), marks the message `sent`, or `failed` with the error after the last retry.
- **Read:** `GET /api/leads/:id/emails` → the caller's own messages for that lead, newest first.
- **Web:** the Email tab's **Send email** sends (toast "Email queued — it is sent from {address}"; the form returns to the
  intro); without a connected mailbox it shows "Connect your Microsoft 365 mailbox in Settings to send email from the CRM."
  with a link instead of sending; the **Emails** tab lists your messages (subject, to, cc, when, Sending / Sent / Failed,
  the text when opened) with its count; the timeline applies the privacy rule.

## 2B-2 (next deploy, outline)

Sync (last 90 days of inbox + sent, then every 5 minutes; delta tokens per folder), matching by address (contact email →
contact → open lead; company domain → company; else Unlinked), the Email screen (folders, smart views, "Show mail for",
search, reading pane, Reply, Log as activity, linked records, thread history, suggested actions, Compose), sidebar Email
entry with unread count, "create lead from email", archive / mark read through Graph. Own design and plan when 2B-1 is live.
