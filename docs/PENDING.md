# Pending items (owner's list)

Kept here at the owner's request; picked up when the owner says so.

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
