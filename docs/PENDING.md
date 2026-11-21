# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so.

## Where things stand (22 Nov 2026, end of session)
- **Live:** crm.daitpartners.com runs release `4bb3601` (2A connections + templates, 2B-1 send from lead, 2B-2 mail
  sync + Email screen, 2C Mailer). Local `main` = live; nothing unmerged. Backups on the server in `~/backups/`
  (`dait_crm-pre-release-2c.dump` is the latest).
- **Owner to do:** run a small test Mailer campaign to your own addresses (1-minute delay, Send now, working hours off)
  and check delivery, Outlook Sent Items, and Queued → Sent on the campaign page; ask Carlos, Lakshita and Sebastian to
  connect their mailboxes (Settings → Email & calendar connections); add Mexico / Chile to the country list; templates
  in English and Spanish; remove LOCAL_ADMIN_LOGIN once everyone signs in with Microsoft.
- **Decided:** Mailer daily limit stays 200 per mailbox ("go with 200 only"); mail stays private to its owner,
  administrators included; Mailer working hours are the client's (Mon–Fri 09:00–18:00 their time).
- **Next release options:** the follow-ups below, 1D (parked), or release 3 (calendar, quotations, projects).

## Parked by the owner
- **1D public contact form + Enquiries** — "keep contact in pending, i will decide lateron" (22 Nov 2026). Open point:
  daitpartners.com/contact already has its own brief form (contact.php → Mailjet).

## Release 2B-2 follow-ups (from the final review, 22 Nov 2026; live release 8b1a8d9)
- Mail in a conversation can link to a lead the user can no longer see (thread match skips the visibility check); the
  list may then show that lead's number.
- A draft sent from Outlook may keep its Draft status in the CRM (status is not updated on existing rows).
- Times show the date only (list, thread history, "synced …"); the prototype shows relative times / time of day.
- After opening a message its list row stays bold for up to a minute.
- Background job rows are never cleaned up (~288 per mailbox per day); a deactivated user's connected mailbox gets an
  empty sync job every minute.
- Compose dialog shows untranslated lead status / source and contact type; the Templates list fills up to six with
  other languages when you have fewer than six in yours.
- Link-to-lead dialog falls back to "create a new lead" when a search hides the lead you had picked.
- Message count on a taken-over mailbox includes the previous owner's mail; Awaiting reply is capped before filters.
- Reply route swallows a database error while locking the lead (inside the transaction).

## Release 2C (Mailer) follow-ups (from the final review, 22 Nov 2026)
- Daily-limit day boundary is an hour off on some daylight-saving change days (e.g. Santiago, Sydney).
- Pause reason ("Paused by …", "Mailbox needs reconnecting") is shown in English for Spanish / French users.
- The Do not email badge and tick box ignore a contact unsubscribed through another lead (the mailer still skips it).
- A lead without a contact has no way to set Do not email (same as the prototype).
- Over a weekend a waiting campaign re-checks every 5 minutes (extra background work; could jump to Monday 09:00).
- If the template is deleted, the unsubscribe line falls back to English.
- Time zone: a company with only a country ignores the lead's own city; some Mexican / Brazilian states are not in the table.
- Wizard still opens when none of the ticked leads can be emailed (prototype refuses with a message); more than 500
  ticked leads shows a generic error.
- Wizard lists all templates (your language first) instead of only your language; "Local time" shows the zone name,
  not the current time there; campaign page has no Message column and links to the lead page, not its Email tab.
- The Mailer list loads every recipient of every campaign (fine now, slower later); no automated test of two steps
  running at once (the lock is correct by reading).
- A mailbox put in error by mail sync pauses a campaign with "Mailbox disconnected" instead of "needs reconnecting".
