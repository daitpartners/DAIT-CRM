import type { Job, Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../jobs/queue.js';
import type { SendEmailPayload } from '../jobs/types.js';

/** Queues an email from the system mailbox; pass the caller's transaction so it commits atomically. */
export function sendSystemEmail(db: Prisma.TransactionClient | PrismaClient, payload: SendEmailPayload): Promise<Job> {
  return enqueue(db, 'send_email', payload);
}
