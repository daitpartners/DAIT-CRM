import type { GraphClient } from '../src/graph/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db';
import { seedLookups as seedLookupsWith } from '../src/seed/lookups';

/** Name of the database in DATABASE_URL, or '' when it cannot be read. */
export function databaseName(url = process.env.DATABASE_URL ?? ''): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/** Empties every table. Refuses unless DATABASE_URL names a throwaway `*_unit` or `*_e2e` database. */
export async function resetDb(): Promise<void> {
  const name = databaseName();
  if (!/_(unit|e2e)$/.test(name)) {
    throw new Error(`resetDb refuses to truncate database "${name}": DATABASE_URL must name a test database ending in _unit or _e2e`);
  }
  const tables = Prisma.dmmf.datamodel.models.map((m) => `"${m.dbName ?? m.name}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export async function seedLookups(): Promise<void> {
  await seedLookupsWith(prisma);
}

/** A GraphClient for tests: the given methods, every other one fails loudly if called. */
export function fakeGraph(impl: Partial<GraphClient> = {}): GraphClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected graph.${name}`);
  };
  return {
    sendMail: unexpected('sendMail'), deltaPage: unexpected('deltaPage'), listAttachments: unexpected('listAttachments'),
    attachmentContent: unexpected('attachmentContent'), calendarDeltaPage: unexpected('calendarDeltaPage'), messageBody: unexpected('messageBody'),
    markRead: unexpected('markRead'), moveTo: unexpected('moveTo'), setFlag: unexpected('setFlag'), deleteMessage: unexpected('deleteMessage'),
    reply: unexpected('reply'), replyAll: unexpected('replyAll'), forward: unexpected('forward'),
    searchPage: unexpected('searchPage'), folderIds: unexpected('folderIds'),
    createDraft: unexpected('createDraft'), createReplyDraft: unexpected('createReplyDraft'), getDraft: unexpected('getDraft'),
    updateDraft: unexpected('updateDraft'), addAttachment: unexpected('addAttachment'), removeAttachment: unexpected('removeAttachment'),
    sendDraft: unexpected('sendDraft'),
    ...impl,
  };
}
