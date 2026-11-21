# Release 2C — Mailer (design)

Owner, 22 Nov 2026: "move 2c" → "Go with your suggestion" (campaign visibility, daily limit), and on working hours:
"can it be client working hour … considering their address can give us tentative idea or can be updated in database"
→ "Please suggest i will go with your suggestion." Standing rule: build what `prototype/index.html` shows
(`views-mailer.js`, mailer rules in `store.js`, Leads bulk bar in `views-leads2.js`); data shape from `docs/data-model.md`
"Mailer". Privacy rule (owner): nobody sees another person's mail, administrators included.

## Intent

A salesperson ticks leads on the Leads list and sends each one a personalised template email from their own Microsoft
365 mailbox, one at a time, spaced out, inside the **client's** working hours, with an audit record per recipient.

## Goals / non-goals / anti-goals

- Goals: the prototype's four-step wizard, Mailer page, campaign page, Do not email, sidebar Mailer entry; sending by the
  worker through Graph; client-local working hours.
- Non-goals: automatic "unsubscribe" reply detection (manual Do not email, as the prototype); open/click tracking;
  attachments; a dedicated bulk-sending service.
- Anti-goals: mail outside the recipient's working day when "working hours only" is on; one person emailed twice in a
  run; anyone reading another user's replies; more than the daily limit from one mailbox.

## Approaches

1. **Chosen:** campaign + recipient tables; the worker's per-minute scheduler queues one `campaign_step` job per due
   campaign; each step sends at most one email (Graph sendMail, synchronously in the job) and sets the next time.
2. One job per recipient queued up front — rejected: pausing, skipping at send time and working hours would mean
   rescheduling many jobs.
3. Reusing `send_user_email` per recipient — rejected: a second job per email doubles the states to track
   (queued/sending) for no gain; the step already runs in the worker with the Graph client.

## Decided

**Who sees what (owner: "go with your suggestion").** Everyone with `use_email` and a connected mailbox can run a
mailer. Each user sees their own campaigns; **Administrators** also see everyone's campaign list, progress, recipients
and statuses (never reply content — "Replied" is a count/flag only). Only the sender can pause, resume, start or cancel.

**Daily limit (owner).** At most **200 mailer emails per mailbox per day** (the sender's calendar day in their time
zone). Over it, the campaign waits ("Daily limit reached — continues tomorrow") and continues the next day.

**Client working hours (owner).** "Only send in working hours" = Monday–Friday 09:00–18:00 **in the recipient's time
zone** (weekdays: builder's call — a Saturday is not a working day). Recipient time zone, first that applies:
1. the company's **Time zone** field (already editable in Edit company) — corrections always win;
2. from the address: single-zone countries by country; US, Canada, Mexico, Brazil, Australia (and Spain's Canary
   Islands) by state / province, else by major city (built-in table);
3. a multi-zone country with no usable state or city: send only when it is working time in **all** its main zones
   (US ≈ 12:00–18:00 New York);
4. unknown country: the sender's time zone.
The address used is the lead's company (country, state, city), else the lead's own country and city. The review step
shows each recipient's zone and its source. A one-time fill sets empty company time zones that resolve to exactly one
zone, so they show on the company and can be corrected. During a run a recipient outside their hours waits; others go.

**Data (one migration).**
- `email_campaigns`: `id`, `name varchar(160)`, `template_id → email_templates (set null)`, `template_name`,
  `template_updated_at`, `subject`, `body`, `sender_id → users`, `account_id → email_accounts (set null)`,
  `sender_address`, `cc text[]`, `bcc text[]`, `start_at null`, `interval_minutes int (1–15)`, `working_hours_only`,
  `unsubscribe_line`, `lawful_basis varchar(160)`, `status` (Scheduled | Sending | Paused | Completed | Cancelled),
  `pause_reason`, `wait_reason` (working hours / daily limit, shown while Sending), `next_send_at`, `created_at`,
  `completed_at`, `cancelled_by_id`. Shown as `MC-001` (id padded).
- `email_campaign_recipients`: `id`, `campaign_id`, `lead_id (set null)`, `contact_id (set null)`, `to_address`
  (unique per campaign), `name`, `company`, `timezones text[]`, `timezone_source` (company | address | country |
  sender), `status` (Queued | Sending | Sent | Failed | Skipped), `sent_at`, `email_message_id → email_messages (set
  null)`, `error`.
- `leads.do_not_email boolean default false`; `contacts.unsubscribed_at timestamptz null`;
  `email_messages.bcc_addresses jsonb default '[]'`, `email_messages.campaign_id → email_campaigns (set null)`.

**Rules (prototype `mailBlock` / `mailerCheck`, checked in the wizard and again at send time):** no email address
(contact's business email, else the lead's), invalid address, Do not email (lead) or unsubscribed (contact), archived,
closed (Won / Lost / Not Relevant), lead not visible to the sender, same address as an earlier recipient in the run; at
send time also "Replied before this email was due" (a received message on the lead in the sender's mail after the
campaign was created).

**Sending.** Each step: the next Queued recipient within their hours (when working-hours-only), skips cost no time;
the email = template subject/body filled per lead (`{first_name}` contact first name else "there", `{company}`, `{me}`,
`{lead_id}` number) + the prototype's unsubscribe line when on; sent via Graph sendMail with Cc/Bcc from the sender's
mailbox; stored as the sender's `email_messages` row (sent, campaign id) with the private "Email sent" history line and
New / Not Contacted → Contacted (as 2B). After a send the next step is `interval` later; nobody in hours → check again
in 5 minutes; daily limit → next day. Auth failure → mailbox `error`, campaign Paused "Mailbox needs reconnecting";
mailbox disconnected → Paused "Mailbox disconnected"; other failure → that recipient Failed with the reason. A
recipient found `Sending` (interrupted) is Failed "interrupted — may have been sent". No Queued left → Completed.
Notifications to the sender: queued, paused, finished (prototype text).

**API (`use_email`):** `POST /mailer/check {leadIds}` → rows (lead, name, company, to, block, time zone + source) and
the sender's mailbox; `POST /mailer {leadIds, name, templateId, cc, bcc, startAt|null, intervalMinutes,
workingHoursOnly, unsubscribeLine, lawfulBasis}`; `GET /mailer` (own; all for Administrators); `GET /mailer/:id`;
`POST /mailer/:id/pause|resume|start|cancel` (sender only); `PATCH /leads/:id/do-not-email {doNotEmail, updatedAt}`
(manage_leads, visible lead) with a history note. `GET /nav-counts` gains `mailerLive` (own Sending + Scheduled).

**Web.** Leads bulk bar **Send via mailer** (disabled with the reason when no mailbox); the wizard (prototype text,
four steps, review table gains a "Local time" column); sidebar **Mailer** after Email with "n live"; Mailer page and
campaign page as the prototype (tiles Sent / Queued / Skipped·failed / Replied, recipients table, Details, Email as
queued, Pause / Resume / Start now / Cancel remaining with confirm); lead profile: Do not email badge and the check box
in Edit profile.

## Left to the builder

Time zone tables, component split, translation keys, migration name, tests (API: rules, visibility, time zone
resolution, working-hours step, daily limit, pause/resume/cancel, interrupted send; web: wizard steps, campaign page;
e2e: tick leads → queue → campaign page, admin sees list, rep sees only own).
