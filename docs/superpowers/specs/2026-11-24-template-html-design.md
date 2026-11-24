# Formatted (HTML) email templates (design)

Owner, 24 Nov 2026: "Under leads > email > there is a template (OFT), while you select OFT template it comes as text
(not in html formatted), can you please [fix] it." Then "deploy" (= go ahead; deploy once reviewed and tested).

## Cause
apps/web/src/lib/oft.ts already extracts the HTML body (MAPI 0x1013) but the template is saved with `body` (plain text)
only; the lead page Email form, Compose and the Mailer use a plain textarea and send `textToHtml(body)`.

## Decided
1. `email_templates.body_html` (new nullable TEXT column, new migration). Uploading an .oft saves the HTML too; the
   server sanitises it with the existing email sanitiser (apps/api/src/mail — same rules as incoming mail, run through
   the existing worker-thread/time-bounded path or the synchronous sanitiser with the 1 MB raw cap), never trusting the
   browser. Manual templates may stay plain (body_html null).
2. A small formatted message editor component (contenteditable, no new dependency) with a toolbar: bold, italic,
   bullet list, numbered list, link (http/https/mailto only). Used in the lead page Email tab, Compose (Email screen) and
   the Mailer wizard's message step. Picking a template with HTML fills the editor with it, merge fields applied (same
   merge rules as today, values HTML-escaped). Picking a plain template / blank keeps today's behaviour (plain text,
   rendered as simple paragraphs). The editor never runs scripts; pasted content is sanitised.
3. Sending: when the message is formatted, the server receives HTML + derived plain text, sanitises the HTML again with
   the same sanitiser, and sends HTML through Graph (reply and new mail) and the Mailer; the stored outgoing message keeps
   body_html (sanitised) and body_text. Unsubscribe line and any appended footer work for HTML too.
4. Template list / editor in Settings shows whether a template is formatted; existing .oft templates (saved as text
   only) keep working as plain text — the owner re-uploads them to get formatting (note in PENDING).
5. Images: http(s) images allowed (as in the reader); inline `cid:` images inside the .oft are dropped for now (listed
   in PENDING).
6. en/es/fr for every new string; only live app styles.

## Left to the builder
Editor implementation details, API shapes, tests (sanitiser on template upload and on send, merge fields escaped,
Graph payload is HTML with text alternative, Mailer step, UI unit + e2e), screenshots of the lead Email tab with an
.oft template before/after.
