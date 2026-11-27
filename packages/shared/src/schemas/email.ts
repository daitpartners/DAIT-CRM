import { z } from 'zod';
import { PagingQuery } from './paging.js';
import { isoDate } from './common.js';
import { FLAG_PRESETS } from '../mailDates.js';
import { TASK_KINDS, TASK_PRIORITIES } from '../leads.js';

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
 * shows as `cid:` and regular attachments. Each at most this many bytes, and all of a template's together too: Graph
 * sendMail takes the attachments in the request itself (at most 4 MB), and base64 makes them a third larger, so 2.5 MB
 * leaves room for the HTML (security review I1; the exact request size is checked again when a message is queued).
 */
export const TEMPLATE_ATTACHMENTS_MAX_BYTES = 2_500_000;
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

/**
 * `POST /mail/:id/reply` (release 2B-2; reply all and forward in web-mail release 2). Reply goes to the sender (or the
 * original recipients of your own message) and Reply all adds the other recipients, so `to` is ignored for both;
 * Forward goes to `to`, which needs at least one address.
 */
export const MailReply = z.object({
  mode: z.enum(['reply', 'replyAll', 'forward']).default('reply'),
  to: z.array(mailAddress).max(20).default([]),
  cc: mailCc,
  body: mailBody,
  bodyHtml,
}).superRefine(plainBodyRule(true)).superRefine((v, ctx) => {
  if (v.mode === 'forward' && v.to.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.too_small, minimum: 1, type: 'array', inclusive: true, path: ['to'] });
  }
});
export type MailReply = z.infer<typeof MailReply>;

/** Seconds a sent message waits in the queue, so Undo can still take it back (web-mail release 3). */
export const UNDO_SEND_SECONDS = 10;

/** What a new Outlook draft starts as (web-mail release 3). */
export const DRAFT_KINDS = ['new', 'reply', 'replyAll', 'forward'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Starting a draft: a new message, or a reply / reply all / forward of `replyToId` (which a new message refuses). */
export const DraftCreate = z.object({
  kind: z.enum(DRAFT_KINDS).default('new'),
  replyToId: z.number().int().positive().optional(),
  leadId: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
}).superRefine((v, ctx) => {
  if (v.kind !== 'new' && v.replyToId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyToId'], message: 'reply_to_required' });
  }
  if (v.kind === 'new' && v.replyToId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyToId'], message: 'reply_to_not_allowed' });
  }
});
export type DraftCreate = z.infer<typeof DraftCreate>;

const recipientList = z.array(mailAddress).max(50).default([]);

/** Saving a draft (auto-save): the whole draft as the editor holds it. */
export const DraftSave = z.object({
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(500).default(''),
  bodyHtml: z.string().max(1_000_000),
  leadId: z.number().int().positive().nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
});
export type DraftSave = z.infer<typeof DraftSave>;

/**
 * The send dialog's follow-up task: day and 24-hour time in the sender's zone, title, assignee, type, priority, an
 * optional note, and whether the lead's next follow-up moves to that day too.
 */
export const SendFollowUp = z.object({
  date: isoDate,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  title: z.string().trim().min(1).max(200),
  assignedToId: z.number().int().positive(),
  kind: z.enum(TASK_KINDS),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  note: z.string().trim().max(1000).optional(),
  updateLead: z.boolean().default(true),
});
export type SendFollowUp = z.infer<typeof SendFollowUp>;

/** Sending a draft: the draft, sent now (after the Undo window) or at `at`, with an optional follow-up. */
export const DraftSend = DraftSave.extend({
  at: z.string().datetime().nullable().default(null),
  followUp: SendFollowUp.nullable().default(null),
});
export type DraftSend = z.infer<typeof DraftSend>;

/** A draft attachment: one file (or an inline picture), uploaded straight to the Outlook draft. */
export const DraftAttachmentUpload = TemplateAttachmentUpload.pick({ name: true, data: true }).extend({
  inline: z.boolean().default(false),
});
export type DraftAttachmentUpload = z.infer<typeof DraftAttachmentUpload>;

/** Applying a template to a draft: fill it from a template, with the template attachments the sender kept. */
export const DraftTemplateApply = z.object({
  templateId: z.number().int().positive(),
  attachmentIds: z.array(z.number().int().positive()).max(TEMPLATE_ATTACHMENTS_MAX_COUNT).default([]),
});
export type DraftTemplateApply = z.infer<typeof DraftTemplateApply>;

/** Characters of a saved signature's HTML at most (after the server sanitises it). */
export const SIGNATURE_HTML_MAX = 20_000;
/** The user's signature: its HTML (null removes it) and whether new messages add it themselves. */
export const SignatureUpdate = z.object({ html: z.string().max(200_000).nullable(), auto: z.boolean() });
export type SignatureUpdate = z.infer<typeof SignatureUpdate>;

/** Recipient search: address suggestions for the To / Cc / Bcc lines. */
export const RecipientQuery = z.object({ q: z.string().trim().min(1).max(100) });
export type RecipientQuery = z.infer<typeof RecipientQuery>;
/** Recipient lookup: who these addresses are (lead, contact, user), for the recipient chips. */
export const RecipientResolve = z.object({ addresses: z.array(mailAddress).max(150) });
export type RecipientResolve = z.infer<typeof RecipientResolve>;

/** Folders a message can be moved to from the Email screen (web-mail release 2). */
export const MOVE_FOLDERS = ['inbox', 'archive', 'deleted'] as const;

/**
 * One change to a message, made in Outlook first (web-mail release 2): move it, delete it permanently, mark it read
 * or unread, or flag it (a due-day preset, Mark complete or Clear flag).
 */
export const MailChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), folder: z.enum(MOVE_FOLDERS) }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('read'), isRead: z.boolean() }),
  z.object({ type: z.literal('flag'), flag: z.enum([...FLAG_PRESETS, 'complete', 'clear']) }),
]);
export type MailChange = z.infer<typeof MailChange>;

/** Most messages one bulk change takes (the selection, or a conversation's messages). */
export const BULK_MAX = 50;
/** `POST /mail/bulk`: the same change to each message. */
export const MailBulk = z.object({ ids: z.array(z.number().int().positive()).min(1).max(BULK_MAX), change: MailChange });
export type MailBulk = z.infer<typeof MailBulk>;

/** `POST /mail/:id/follow-up`: the linked lead's next follow-up day and 24-hour time (the user's zone), or clear it. */
export const MailFollowUp = z.union([
  z.object({ date: isoDate, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.object({ clear: z.literal(true) }),
]);
export type MailFollowUp = z.infer<typeof MailFollowUp>;

/**
 * Email screen folders (web-mail release 2), shared by the API and the screen. The list query keeps `view` a plain
 * string: an unknown view (the retired `unlinked` included) is read as the Inbox rather than refused.
 */
export const MAIL_VIEWS = ['inbox', 'sent', 'drafts', 'scheduled', 'flagged', 'archive', 'deleted', 'awaiting', 'due', 'mine'] as const;
export type MailView = (typeof MAIL_VIEWS)[number];
/** Email list sort keys. */
export const MAIL_SORTS = ['date', 'from', 'lead', 'stage', 'size'] as const;
export type ListSort = (typeof MAIL_SORTS)[number];
/** Email list quick filters (the chips above the list). */
export const MAIL_CHIPS = ['all', 'unread', 'flagged', 'attachments'] as const;
export type MailChip = (typeof MAIL_CHIPS)[number];

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
  /**
   * Web-mail release 1, whose mail (default `me`): `all` = yours plus every other user's lead mail, or a user id = that
   * user's lead mail. Anything but your own needs `view_team_mail` (Administrator, Manager) and is view only.
   */
  mailOf: z.union([z.enum(['me', 'all']), z.string().regex(/^\d{1,9}$/)]).optional(),
  /** Web-mail release 2: a quick filter chip. */
  chip: z.enum(MAIL_CHIPS).optional(),
  /** `0`: one row per message instead of per conversation (the default). */
  conv: z.enum(['0', '1']).optional(),
  sort: z.enum(MAIL_SORTS).optional(),
  dir: z.enum(['desc', 'asc']).optional(),
  /** Filters panel: text in the sender, the recipients, the subject or the linked lead / client. */
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  leadQ: z.string().max(200).optional(),
  /** Filters panel: the linked lead's assignee (`me` or a user id). */
  owner: z.union([z.literal('me'), z.string().regex(/^\d{1,9}$/)]).optional(),
  /** Filters panel: received today or in the last 7 days / 30 days / 12 months, or `custom` = `since`..`until`. */
  date: z.enum(['today', '7d', '30d', '12m', 'custom']).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  /** `1`: only messages with attachments. */
  attachments: z.literal('1').optional(),
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
