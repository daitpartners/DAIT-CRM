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

/** `POST /email-templates`: written in the CRM ('manual') or read from an uploaded Outlook file ('oft'). */
export const EmailTemplateInput = z.object({
  name: z.string().trim().min(1).max(150),
  language: z.enum(TEMPLATE_LANGUAGES),
  subject: z.string().trim().min(1).max(500),
  body: z.string().max(20000).default(''),
  /** The template's HTML (from an .oft, or written in the formatted editor); sanitised by the server. */
  bodyHtml,
  sourceType: z.enum(['manual', 'oft']).default('manual'),
  fileName: z.string().trim().max(255).nullable().optional(),
  fileSize: z.number().int().min(0).max(TEMPLATE_FILE_MAX_BYTES).nullable().optional(),
});
export type EmailTemplateInput = z.infer<typeof EmailTemplateInput>;

/** `POST /email-templates/sanitize`: an uploaded .oft's HTML, made safe before the template editor shows it. */
export const TemplateHtmlCheck = z.object({ html: z.string().max(MESSAGE_HTML_MAX_CHARS) });

/** `PATCH /email-templates/:id`: any subset, with the `updatedAt` the editor loaded. */
export const EmailTemplateUpdate = EmailTemplateInput.omit({ sourceType: true, fileName: true, fileSize: true })
  .partial()
  .extend({ updatedAt: z.string().datetime() });
export type EmailTemplateUpdate = z.infer<typeof EmailTemplateUpdate>;

/** `POST /leads/:id/emails` (release 2B-1): sent through the caller's own Microsoft 365 mailbox. */
export const LeadEmailSend = z.object({
  to: z.string().trim().toLowerCase().email(),
  cc: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20000),
  /** Formatted message: its HTML (sanitised again by the server); `body` is then its plain text. */
  bodyHtml,
  /** Set the lead's next follow-up this many days from today (prototype "Set follow-up in"); null = leave it. */
  followUpDays: z.union([z.literal(2), z.literal(3), z.literal(7)]).nullish(),
  /** Release 3B: tag it with one of the lead's company's projects (a project the sender can see). */
  projectId: z.number().int().positive().nullish(),
  updatedAt: z.string().datetime(),
});
export type LeadEmailSend = z.infer<typeof LeadEmailSend>;

const mailAddress = z.string().trim().toLowerCase().email();
const mailCc = z.array(mailAddress).max(20).default([]);
const mailBody = z.string().trim().min(1).max(20000);

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
});
export type MailCompose = z.infer<typeof MailCompose>;

/** `POST /mail/:id/reply` (release 2B-2): to the sender (or the original recipients of your own message). */
export const MailReply = z.object({ cc: mailCc, body: mailBody, bodyHtml });
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
