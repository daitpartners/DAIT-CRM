# Email reader: Outlook-like formatting, no page numbers (design)

Owner, 23 Nov 2026 (after the UI release fe5bb19 went live): "remove the page number in the email, also, there is the
code coming in the body, it should come proper formatting, as it look in outlook. Keep page height fix (fluid with
resolution on the monitor)."

## Cause found
Mail sync asks Microsoft Graph for `outlook.body-content-type="text"` (apps/api/src/graph/client.ts ~353) and stores
only `email_messages.body_text`; Graph's HTML→text conversion leaves CSS/markup in many HTML emails, and the reader shows
`bodyText` as plain text (apps/web/src/pages/email/Reader.tsx ~94).

## Decided
1. **Formatted bodies.** Store the HTML body too (new nullable column `body_html` on `email_messages`; keep `body_text`
   for previews, search and everything that uses it today). Sync fetches HTML (`outlook.body-content-type="html"`) and
   derives `body_text` from it server-side (a sane HTML→text that drops <style>/<script>/<head> and collapses
   whitespace), so previews/search improve too. Size cap as today (BODY_MAX) for both.
2. **Sanitised on the server** before storing/serving: allow normal email formatting (text, links, lists, tables,
   inline styles that are safe, images); strip scripts, event handlers, forms, iframes/objects/embeds, meta refresh,
   `javascript:`/`data:` URLs except `data:image/*`, CSS expressions/`url(javascript:)`. Links open in a new tab with
   `rel="noopener noreferrer"`. Use one established, maintained sanitiser pinned to a version at least 2 weeks old.
3. **Rendered isolated:** the reader shows the HTML in an `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">`
   (no scripts, no same-origin) via `srcdoc`, with a CSP meta inside the doc (`default-src 'none'; img-src https: http:
   data:; style-src 'unsafe-inline'`), auto-sized to its content height inside the reader's own scrolling column (the
   fluid layout stays). Plain-text emails (no HTML) render as today (pre-wrap text).
4. **Existing messages:** when a message without `body_html` is opened, the API fetches its HTML body from Graph once
   (the owner's own mailbox only — mail stays private to its owner, administrators included), sanitises, stores and
   returns it; if Graph fails, fall back to `body_text`. No bulk backfill.
5. **Remote images:** shown, as Outlook does. Inline `cid:` images (embedded attachments) are not fetched in this
   change — hidden rather than shown broken; listed in PENDING.
6. **CRM-sent mail** already goes out as HTML from text (`textToHtml`); store that HTML as `body_html` too so it
   displays consistently.
7. **No page numbers in the Email list:** remove First/Prev/Page/Next/Last and the Rows selector; the list loads the next
   batch of 50 automatically when scrolled near its bottom (infinite scroll within the list column, with a small
   "Loading…" row and the existing total shown as "62 messages"); selection, filters, unread state and URL behaviour
   keep working; `?page`/`?size` in old URLs are ignored and removed.
8. **Keep** the fluid Email height (fe5bb19): the screen fits the monitor; columns scroll on their own.

## Left to the builder
Sanitiser choice (pinned, ≥2 weeks old), HTML→text helper, iframe auto-height approach, API shape for the on-open fetch,
tests (sanitiser cases incl. XSS vectors; sync stores html+text; on-open fetch only for own mail; infinite scroll),
screenshots of a few real-world-like HTML emails (newsletter, signature with table, reply chain) vs how Outlook shows
them.
