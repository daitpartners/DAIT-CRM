import type { MailAttachment } from '../graph/client.js';
import type { QuotationSnapshot } from '../quotations/service.js';

export type JobType =
  | 'send_email' | 'send_user_email' | 'sync_mailbox' | 'mail_action' | 'campaign_step' | 'sync_calendar' | 'research_company'
  | 'import_read_file' | 'import_commit';

export const JOB_TYPES: readonly JobType[] = [
  'send_email', 'send_user_email', 'sync_mailbox', 'mail_action', 'campaign_step', 'sync_calendar', 'research_company',
  'import_read_file', 'import_commit',
];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface SendEmailPayload {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  relatedTo?: { entityType: string; entityId: string };
}

/** `send_user_email` (release 2B-1): a message a user sent from the CRM, through their own mailbox. */
export interface SendUserEmailPayload {
  emailMessageId: number;
  /** Release 3A: files sent with it (the quotation PDF, drawn when the send was queued). */
  attachments?: MailAttachment[];
  /** Release 3A: the quotation it sends and the snapshot printed on the PDF (frozen as the revision when it is sent). */
  quotation?: { id: number; snapshot: QuotationSnapshot };
}

/** `sync_mailbox` (release 2B-2): read new mail from a personal mailbox. */
export interface SyncMailboxPayload {
  accountId: number;
}

/** `sync_calendar` (release 3C): copy the owner's Outlook calendar from a personal mailbox. */
export interface SyncCalendarPayload {
  accountId: number;
}

/** `mail_action` (release 2B-2): a change the user made in the CRM, applied to their mailbox. */
export interface MailActionPayload {
  emailMessageId: number;
  action: 'read' | 'unread' | 'archive';
}

/** `research_company` (release 4): run one queued AI research run. */
export interface ResearchCompanyPayload {
  runId: number;
}

/**
 * `import_read_file` (Import leads): read one uploaded file. Queued with `maxAttempts: 1`, since a retry could spend
 * Claude twice; a file left Reading after its job is lost is swept to Failed.
 */
export interface ImportReadFilePayload {
  fileId: number;
}

/** `import_commit` (Import leads): import a batch's approved rows, one row per transaction (resumable). */
export interface ImportCommitPayload {
  batchId: number;
}
