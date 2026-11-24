import { z } from 'zod';
import { PagingQuery } from './paging.js';

/** `PATCH /mailboxes/:id` (prototype "Mailbox options"); every field optional. */
export const MailboxOptions = z.object({
  syncMail: z.boolean(),
  syncCalendar: z.boolean(),
  sharedMailboxes: z.array(z.string().trim().toLowerCase().email()).max(10),
}).partial();
export type MailboxOptions = z.infer<typeof MailboxOptions>;

/** Largest Outlook file the templates card reads (they are usually under 1 MB). */
export const TEMPLATE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const TEMPLATE_LANGUAGES = ['en', 'es', 'fr'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/**
 * Formatted (HTML) message bodies (templates read from an .oft, and the formatted message editor): the most characters
 * of HTML a request may carry. The server sanitises them (the email reader's sanitiser) and reads at most this much,
 * as for incoming mail.
 */
export const MESSAGE_HTML_MAX_CHARS = 1_000_000;
/** A formatted body: null / absent for a plain-text message. */
const bodyHtml = z.string().max(MESSAGE_HTML_MAX_CHARS).nullish();
/** Characters of a plain-text message or template body. */
export const PLAIN_BODY_MAX = 20000;
/**
 * The plain `body` beside a formatted one: the server derives the message's text from the HTML, so with HTML the
 * plain body is only a fallback, neither required nor held to PLAIN_BODY_MAX; without HTML it is the message.
 */
const looseBody = z.string().trim().max(MESSAGE_HTML_MAX_CHARS);
function plainBodyRule(required: boolean) {
  return (v: { body?: string; bodyHtml?: string | null }, ctx: z.RefinementCtx) => {
    if (v.bodyHtml?.trim() || v.body === undefined) return;
    if (required && !v.body) ctx.addIssue({ code: z.ZodIssueCode.too_small, minimum: 1, type: 'string', inclusive: true, path: ['body'] });
    if (v.body.length > PLAIN_BODY_MAX) ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: PLAIN_BODY_MAX, type: 'string', inclusive: true, path: ['body'] });
  };
}

/**
 * Template pictures and attachments (owner, 24 Nov 2026): the files of an uploaded .oft — inline pictures the HTML
 * shows as `cid:` and regular attachments. Each at most this many bytes, and all of a template's together too (Graph
 * sendMail takes the attachments in the request itself).
 */
export const TEMPLATE_ATTACHMENTS_MAX_BYTES = 3_000_000;
/** Files a template may keep. */
export const TEMPLATE_ATTACHMENTS_MAX_COUNT = 20;
/** Base64 characters of one file at most (TEMPLATE_ATTACHMENTS_MAX_BYTES encoded). */
const ATTACHMENT_BASE64_MAX = Math.ceil(TEMPLATE_ATTACHMENTS_MAX_BYTES / 3) * 4;
/** Characters of an attachment's content-id (what `cid:` refers to) at most. */
export const ATTACHMENT_CID_MAX = 200;

/**
 * One file uploaded with a template, as read from the .oft in the browser: its name, its content-id when the HTML
 * shows it inline, and its bytes as base64. The server checks the bytes (type by magic bytes, size) and the name.
 */
export const TemplateAttachmentUpload = z.object({
  name: z.string().trim().min(1).max(255),
  contentId: z.string().trim().max(ATTACHMENT_CID_MAX).nullish(),
  inline: z.boolean().default(false),
  data: z.string().min(1).max(ATTACHMENT_BASE64_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Not base64'),
});
export type TemplateAttachmentUpload = z.infer<typeof TemplateAttachmentUpload>;
const templateAttachments = z.array(TemplateAttachmentUpload).max(TEMPLATE_ATTACHMENTS_MAX_COUNT);

const EmailTemplateFields = z.object({
  name: z.string().trim().min(1).max(150),
  language: z.enum(TEMPLATE_LANGUAGES),
  subject: z.string().trim().min(1).max(500),
  body: z.string().max(MESSAGE_HTML_MAX_CHARS).default(''),
  /** The template's HTML (from an .oft, or written in the formatted editor); sanitised by the server. */
  bodyHtml,
  sourceType: z.enum(['manual', 'oft']).default('manual'),
  fileName: z.string().trim().max(255).nullable().optional(),
  fileSize: z.number().int().min(0).max(TEMPLATE_FILE_MAX_BYTES).nullable().optional(),
  /** The .oft's pictures and attachments; on an update, present replaces them all (absent keeps them). */
  attachments: templateAttachments.optional(),
});
/** `POST /email-templates`: written in the CRM ('manual') or read from an uploaded Outlook file ('oft'). */
export const EmailTemplateInput = EmailTemplateFields.superRefine(plainBodyRule(false));
export type EmailTemplateInput = z.infer<typeof EmailTemplateInput>;

/** `POST /email-templates/sanitize`: an uploaded .oft's HTML, made safe before the template editor shows it. */
export const TemplateHtmlCheck = z.object({
  html: z.string().max(MESSAGE_HTML_MAX_CHARS),
  /** Content-ids of the inline pictures uploaded with it: only these `cid:` pictures are kept. */
  cids: z.array(z.string().trim().max(ATTACHMENT_CID_MAX)).max(TEMPLATE_ATTACHMENTS_MAX_COUNT).default([]),
});

/** `PATCH /email-templates/:id`: any subset, with the `updatedAt` the editor loaded. */
export const EmailTemplateUpdate = EmailTemplateFields.omit({ sourceType: true, fileName: true, fileSize: true })
  .partial()
  .extend({ updatedAt: z.string().datetime() })
  .superRefine(plainBodyRule(false));
export type EmailTemplateUpdate = z.infer<typeof EmailTemplateUpdate>;

/**
 * A message filled from a template with files: the template (its inline pictures go with the HTML that shows them)
 * and the regular attachments the sender kept (each one of that template's).
 */
const templateFiles = {
  templateId: z.number().int().positive().nullish(),
  attachmentIds: z.array(z.number().int().positive()).max(TEMPLATE_ATTACHMENTS_MAX_COUNT).default([]),
};

/** `POST /leads/:id/emails` (release 2B-1): sent through the caller's own Microsoft 365 mailbox. */
export const LeadEmailSend = z.object({
  to: z.string().trim().toLowerCase().email(),
  cc: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
  subject: z.string().trim().min(1).max(500),
  body: looseBody.default(''),
  /** Formatted message: its HTML (sanitised again by the server, which derives the plain text from it). */
  bodyHtml,
  /** Set the lead's next follow-up this many days from today (prototype "Set follow-up in"); null = leave it. */
  followUpDays: z.union([z.literal(2), z.literal(3), z.literal(7)]).nullish(),
  /** Release 3B: tag it with one of the lead's company's projects (a project the sender can see). */
  projectId: z.number().int().positive().nullish(),
  ...templateFiles,
  updatedAt: z.string().datetime(),
}).superRefine(plainBodyRule(true));
export type LeadEmailSend = z.infer<typeof LeadEmailSend>;

const mailAddress = z.string().trim().toLowerCase().email();
const mailCc = z.array(mailAddress).max(20).default([]);
const mailBody = looseBody.default('');

/** `POST /mail` (release 2B-2, Email screen Compose): optionally on a lead or for a client. */
export const MailCompose = z.object({
  to: mailAddress,
  cc: mailCc,
  subject: z.string().trim().min(1).max(500),
  body: mailBody,
  bodyHtml,
  leadId: z.number().int().positive().nullish(),
  companyId: z.number().int().positive().nullish(),
  /** Release 3B: a project the sender can see, of the lead's company (or the client given without a lead). */
  projectId: z.number().int().positive().nullish(),
  ...templateFiles,
}).superRefine(plainBodyRule(true));
export type MailCompose = z.infer<typeof MailCompose>;

/** `POST /mail/:id/reply` (release 2B-2): to the sender (or the original recipients of your own message). */
export const MailReply = z.object({ cc: mailCc, body: mailBody, bodyHtml }).superRefine(plainBodyRule(true));
export type MailReply = z.infer<typeof MailReply>;

/**
 * `GET /mail` (Email screen list; paged at the owner's request, 22 Nov 2026): 50 a page, at most 100 as other lists.
 * An unknown view or a non-numeric client/lead is ignored rather than refused, as before paging.
 */
export const MailListQuery = PagingQuery.pick({ page: true, pageSize: true }).extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  view: z.string().optional(),
  company: z.string().optional(),
  lead: z.string().optional(),
  /** Release 3B: only the caller's own messages tagged with this project. */
  project: z.string().optional(),
  s: z.string().optional(),
  /** `0`: no total (later batches of the Email list, which scrolls; the first batch carries it). */
  count: z.enum(['0', '1']).optional(),
});
export type MailListQuery = z.infer<typeof MailListQuery>;

/** `POST /mail/:id/read`. */
export const MailRead = z.object({ isRead: z.boolean() });

/** `POST /mail/:id/link`. */
export const MailLink = z.object({ leadId: z.number().int().positive() });

/** Prototype mailer lawful bases (views-mailer.js `lawful`); one is required before queueing. */
export const LAWFUL_BASES = [
  'Legitimate interest (B2B outreach relevant to their role)',
  'Consent (they asked to be contacted)',
  'Existing client or business relationship',
] as const;
/** Delay between mailer emails, in minutes (prototype options). */
export const MAILER_INTERVALS = [1, 2, 3, 5, 10, 15] as const;
/** Mailer emails per mailbox per day (owner, 22 Nov 2026). */
export const MAILER_DAILY_LIMIT = 200;

/** `POST /mailer/check` (release 2C). */
export const MailerCheck = z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(500) });

/** `POST /mailer` (release 2C): the wizard's four steps. */
export const MailerCreate = MailerCheck.extend({
  name: z.string().trim().max(160).default(''),
  templateId: z.number().int().positive(),
  cc: mailCc,
  bcc: mailCc,
  startAt: z.string().datetime().nullish(),
  intervalMinutes: z.number().int().refine((n) => (MAILER_INTERVALS as readonly number[]).includes(n), 'Choose 1, 2, 3, 5, 10 or 15 minutes'),
  workingHoursOnly: z.boolean().default(false),
  unsubscribeLine: z.boolean().default(true),
  lawfulBasis: z.enum(LAWFUL_BASES),
});
export type MailerCreate = z.infer<typeof MailerCreate>;
