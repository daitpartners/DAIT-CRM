import { z } from 'zod';

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

/** `POST /email-templates`: written in the CRM ('manual') or read from an uploaded Outlook file ('oft'). */
export const EmailTemplateInput = z.object({
  name: z.string().trim().min(1).max(150),
  language: z.enum(TEMPLATE_LANGUAGES),
  subject: z.string().trim().min(1).max(500),
  body: z.string().max(20000).default(''),
  sourceType: z.enum(['manual', 'oft']).default('manual'),
  fileName: z.string().trim().max(255).nullable().optional(),
  fileSize: z.number().int().min(0).max(TEMPLATE_FILE_MAX_BYTES).nullable().optional(),
});
export type EmailTemplateInput = z.infer<typeof EmailTemplateInput>;

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
  /** Set the lead's next follow-up this many days from today (prototype "Set follow-up in"); null = leave it. */
  followUpDays: z.union([z.literal(2), z.literal(3), z.literal(7)]).nullish(),
  updatedAt: z.string().datetime(),
});
export type LeadEmailSend = z.infer<typeof LeadEmailSend>;
