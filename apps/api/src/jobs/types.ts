export type JobType = 'send_email' | 'send_user_email';

export const JOB_TYPES: readonly JobType[] = ['send_email', 'send_user_email'];

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
}
