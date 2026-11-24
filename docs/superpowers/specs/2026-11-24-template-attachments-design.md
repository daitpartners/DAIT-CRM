# Template pictures and attachments (design)

Owner, 24 Nov 2026 (after formatted templates went live, a7bf0e1): "I just send using the oft, but it does not look good
in plain text, how can be fixed with images and everything similar to outlook."

## Found
- The template used ("DAIT-Holiday-2026-Email_2", id 1) was uploaded 22 Nov, before formatted templates: body_html is
  empty, so it sent as plain text. Re-uploading fixes the formatting.
- The owner's .oft files (e.g. ~/Downloads/DAIT-Holiday-2026-Email-Deepak Final.oft) hold MAPI attachments: two inline
  PNGs referenced from the HTML as `cid:dait-logo-dark.png` / `cid:dait-logo-signature.png` (attach content-id 0x3712,
  mime 0x370E, data 0x3701) and one regular attachment `DAIT-Holiday-2026-Deepak.pdf` (~1 MB). Today the sanitiser drops
  cid images and attachments are ignored.

## Decided
1. Template attachments stored server-side: new table `email_template_attachments` (template, file name, content type,
  size, content-id nullable, inline flag, storage path under STORAGE_DIR/templates/<id>/, sha256). Parsed from the .oft
  in the browser (extend apps/web/src/lib/oft.ts to read attachment storages) and uploaded with the template; the server
  validates type by magic bytes (images: png, jpeg, gif; documents: pdf, docx, xlsx, doc, xls, pptx) and size (each
  ≤ 3 MB, total per template ≤ 3 MB — Graph sendMail inline-attachment request limit), file names sanitised.
2. The sanitiser keeps `cid:` image references ONLY when they match an inline attachment of that template / message
  (outgoing mode); everything else as today.
3. Editor and Mailer preview show inline images: cid: replaced for display with an authenticated same-origin URL? NO —
  the editor iframe is credentialless and own-host URLs are dropped; use `data:image/...;base64` for display only
  (small images), mapped back to cid: before sending. Attachments listed under the message with name + size; the sender
  may remove a regular attachment before sending (not inline ones).
4. Sending (lead email, Compose, reply excluded unless the template is used there, Mailer): Graph sendMail/reply with
  fileAttachment items — inline images with `isInline: true` and `contentId`, regular attachments as normal; total ≤ 3 MB
  else 413 `attachments_too_large` (en/es/fr). Stored outgoing message records attachment names (existing
  attachmentNames).
5. Access: template attachments readable by users who can use templates; never exposed to other users' mail. Files
  deleted when the template is deleted or replaced.
6. Re-upload needed for existing templates (PENDING line). en/es/fr; only live app styles.

## Left to the builder
Exact parser changes, API shapes, storage helpers (reuse imports/storage patterns), tests (oft parse with the sample
file docs/sample-template.oft plus a generated fixture with cid images + pdf; sanitiser cid allow-list; Graph payload
shape with fake Graph; size limits; Mailer), screenshots of the lead Email tab showing the logos and attachment chip.
