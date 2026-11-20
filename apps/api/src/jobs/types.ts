export type JobType = 'send_email';

export const JOB_TYPES: readonly JobType[] = ['send_email'];

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
