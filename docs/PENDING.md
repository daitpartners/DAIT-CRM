# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so.

## Where things stand (22 Nov 2026, end of session)
- **Live:** crm.daitpartners.com runs release `4bb3601` (2A connections + templates, 2B-1 send from lead, 2B-2 mail
  sync + Email screen, 2C Mailer). Backups on the server in `~/backups/` (`dait_crm-pre-release-2c.dump` is the latest).
- **Ready, not merged, not deployed:** branch `mail-follow-ups` holds the 2B-2 / 2C follow-ups below plus visual-parity
  fixes so Email, Compose, Link to lead, the Mailer list, the campaign page, the wizard and the Leads bulk bar match the
  prototype. Local `main` = live. Needs merge + "deploy" from the owner.
- **Owner to do:** run a small test Mailer campaign to your own addresses (1-minute delay, Send now, working hours off)
  and check delivery, Outlook Sent Items, and Queued → Sent on the campaign page; ask Carlos, Lakshita and Sebastian to
  connect their mailboxes (Settings → Email & calendar connections); add Mexico / Chile to the country list; templates
  in English and Spanish; remove LOCAL_ADMIN_LOGIN once everyone signs in with Microsoft; answer the owner decisions below.
- **Decided:** Mailer daily limit stays 200 per mailbox ("go with 200 only"); mail stays private to its owner,
  administrators included; Mailer working hours are the client's (Mon–Fri 09:00–18:00 their time).
- **Next release options:** deploy `mail-follow-ups`, the follow-ups from this round, 1D (parked), or release 3
  (calendar, quotations, projects).

## Owner decisions (please confirm)
- **Leads bulk bar: Assign to… and Archive** are not in the prototype. Owner (22 Nov): "keep in pending list" — kept as
  built for now; decide later whether to drop them to match the prototype exactly.
- **Email reader Archive button** is not in the prototype; it was approved in the 2B-2 design. Keep or remove?
- **Edit profile dialog layout and contact line order** differ from the prototype (decided in the leads exact-match
  design). Confirm this is still wanted.
- **Mailer list shows the pause reason** ("Paused by …", "Mailbox needs reconnecting"); the prototype does not. Keep?
- **Background job clean-up:** finished jobs are now deleted after 7 days and failed jobs after 30 days (old failures
  can no longer be retried from the jobs view). OK?

## Parked by the owner
- **1D public contact form + Enquiries** — "keep contact in pending, i will decide lateron" (22 Nov 2026). Open point:
  daitpartners.com/contact already has its own brief form (contact.php → Mailjet).

## Release 2B-2 follow-ups (from the final review, 22 Nov 2026; live release 8b1a8d9) — fixed on `mail-follow-ups`
- ~~Mail in a conversation can link to a lead the user can no longer see (thread match skips the visibility check); the
  list may then show that lead's number.~~ Done `63c6e57`.
- ~~A draft sent from Outlook may keep its Draft status in the CRM (status is not updated on existing rows).~~ Done `f2489c1`.
- ~~Times show the date only (list, thread history, "synced …"); the prototype shows relative times / time of day.~~
  Done `7531818`, `2ad59ce`.
- ~~After opening a message its list row stays bold for up to a minute.~~ Done `7531818`.
- ~~Background job rows are never cleaned up (~288 per mailbox per day); a deactivated user's connected mailbox gets an
  empty sync job every minute.~~ Done `f2489c1`.
- ~~Compose dialog shows untranslated lead status / source and contact type~~ — done `7531818`. The Templates list
  filling up to six with other languages — kept by design (matches the prototype).
- ~~Link-to-lead dialog falls back to "create a new lead" when a search hides the lead you had picked.~~ Done `7531818`.
- ~~Message count on a taken-over mailbox includes the previous owner's mail~~ — done `f2489c1`. ~~Awaiting reply is
  capped before filters~~ — done `63c6e57`.
- ~~Reply route swallows a database error while locking the lead (inside the transaction).~~ Done `63c6e57`.
- Visual parity (Email reader contact card, thread history, Compose, Link to lead searchable select) — done `daffce4`.

## Release 2C (Mailer) follow-ups (from the final review, 22 Nov 2026) — fixed on `mail-follow-ups`
- ~~Daily-limit day boundary is an hour off on some daylight-saving change days (e.g. Santiago, Sydney).~~ Done `eab83c5`.
- ~~Pause reason ("Paused by …", "Mailbox needs reconnecting") is shown in English for Spanish / French users.~~
  Done `246ec7b`.
- ~~The Do not email badge and tick box ignore a contact unsubscribed through another lead (the mailer still skips
  it).~~ Done `cb90c47`.
- A lead without a contact has no way to set Do not email — kept by design (matches the prototype).
- ~~Over a weekend a waiting campaign re-checks every 5 minutes (extra background work; could jump to Monday 09:00).~~
  Done `a51a424`.
- ~~If the template is deleted, the unsubscribe line falls back to English.~~ Done `a51a424`.
- ~~Time zone: a company with only a country ignores the lead's own city; some Mexican / Brazilian states are not in the
  table.~~ Done `a51a424` (lead city), `eab83c5` (all states).
- ~~Wizard still opens when none of the ticked leads can be emailed (prototype refuses with a message); more than 500
  ticked leads shows a generic error.~~ Done `246ec7b`.
- Wizard lists all templates (your language first) — kept by design (matches the prototype). ~~"Local time" shows the
  zone name, not the current time there; campaign page has no Message column~~ — done `246ec7b`. Campaign page links to
  the lead page, not its Email tab — kept by design (matches the prototype; the lead page opens on the Email tab).
- ~~The Mailer list loads every recipient of every campaign (fine now, slower later)~~ — done `3716c44`. ~~No automated
  test of two steps running at once~~ — done `a51a424`.
- ~~A mailbox put in error by mail sync pauses a campaign with "Mailbox disconnected" instead of "needs
  reconnecting".~~ Done `a51a424`.
- Visual parity (Mailer list, campaign page, wizard, Leads bulk bar with Send via mailer at the right) — done `7b7b6c5`.

## Follow-ups from this round (mail follow-ups review, 22 Nov 2026; not fixed yet unless marked)
- ~~**Important (also on live):** the Email screen crashes ("Invalid time value") when the open message's lead has a
  next follow-up date.~~ **Fixed (1fe84da, not deployed):** GET /api/mail/:id now gives `lead.nextFollowUp` as
  `YYYY-MM-DD` like the lead API, so the reader's day formatter gets a calendar date. The parity mail spec also
  re-unlinks "Website enquiry" (email.spec makes a lead from it earlier in the full run).
- A mail sync already queued still runs once after a user is deactivated (later syncs stop).
- Opening a message straight from a link (/email/…) may keep its list row bold until the list refreshes.
- Two incoming mails in a row in a thread both read "reply received".
- Your own sent message, opened, reads "sent by <your name>" instead of "sent" as in the prototype.
- Very long conversations show only the latest 50 messages.
- An older message in a linked conversation can still show as unmatched.
- The Mailer wizard closes if the Leads list refreshes and the ticked leads clear.
- A mailbox disconnected after the Leads page loaded is only refused when you press Queue in the wizard.
- Ticking Do not email on two leads of the same contact at the same moment could leave one flag unsaved (rare);
  ticking lead B when the contact is already unsubscribed does not set B's own flag.
- Mexican state codes such as JAL, NLE are not recognised (full state names are).
- Brazilian 2-letter state codes may match a city name instead and pick the wrong time zone.
- The mail list stops at 5000 messages without saying so; the company filter can match through a lead you cannot see.
- The Compose contact line "· COO · primary" is not greyed out as in the prototype; Details values wrap slightly earlier.
- Keyboard: Shift+Tab can leave an open dialog.
