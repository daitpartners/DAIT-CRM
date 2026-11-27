// e2e only: runs the queued `send_user_email` jobs against a fake Microsoft Graph that accepts every message, so a
// spec can see a send succeed (the e2e server runs no worker). Run with tsx (`npx tsx test/e2e-send-jobs.ts`).
// Web-mail release 3: jobs waiting out the Undo window (or a scheduled time) are made due first, so they run now.
import type { GraphClient, GraphResponseMessage } from '../src/graph/client';

process.env.DATABASE_URL ??= 'postgresql://mac@localhost:5432/dait_crm_e2e';

// Sends every queued mail job through a fake Graph and marks it done: never against a database other than an e2e one.
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!dbName.endsWith('_e2e')) {
  console.error(`e2e-send-jobs: refusing to run against database "${dbName}" (its name must end in _e2e)`);
  process.exit(1);
}

// Imported after DATABASE_URL is settled so the Prisma client connects to the e2e database.
const { prisma } = await import('../src/db');
const { runOnce } = await import('../src/jobs/runner');
const { sendUserEmailHandler } = await import('../src/jobs/handlers/sendUserEmail');

const refuse = () => Promise.reject(new Error('not used in e2e'));
const respond = (kind: 'reply' | 'replyAll' | 'forward', graphId: string, msg: GraphResponseMessage) => {
  console.log(`e2e-sent: ${JSON.stringify({ kind, graphId, to: msg.to, cc: msg.cc ?? [], html: msg.html })}`);
};
const graph: GraphClient = {
  // Each message "sent" is printed as one `e2e-sent: {json}` line, so a spec can check what Graph was given.
  sendMail: async (_account, msg) => {
    // Attachments as Graph would get them (name, type, inline / content-id), with their size instead of the bytes.
    const attachments = (msg.attachments ?? []).map((a) => ({
      name: a.name, contentType: a.contentType, isInline: a.isInline ?? false, contentId: a.contentId ?? null, size: Buffer.from(a.contentBase64, 'base64').length,
    }));
    console.log(`e2e-sent: ${JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, attachments })}`);
  },
  // Reply, Reply all and Forward (web-mail release 2) are accepted too, printed as `e2e-sent: {json}` with their kind.
  reply: async (_account, graphId, msg) => respond('reply', graphId, msg),
  replyAll: async (_account, graphId, msg) => respond('replyAll', graphId, msg),
  forward: async (_account, graphId, msg) => respond('forward', graphId, msg),
  deltaPage: refuse, listAttachments: refuse, attachmentContent: refuse, markRead: refuse, moveTo: refuse, setFlag: refuse, deleteMessage: refuse,
  calendarDeltaPage: refuse, messageBody: refuse, searchPage: refuse, folderIds: refuse,
  createDraft: refuse, createReplyDraft: refuse, updateDraft: refuse, addAttachment: refuse, removeAttachment: refuse,
  // The worker asks Outlook about a draft only after a send call failed (never here, where every send succeeds): the
  // CRM row that holds it, as Graph would give it.
  getDraft: async (account, draftId) => {
    const row = await prisma.emailMessage.findFirst({ where: { graphId: draftId, accountId: account.id } });
    if (!row) throw new Error(`e2e-send-jobs: no CRM row for draft ${draftId}`);
    return {
      id: draftId, conversationId: row.threadId, subject: row.subject, html: row.bodyHtml ?? '', to: row.toAddresses as string[], cc: row.ccAddresses as string[],
      bcc: row.bccAddresses as string[], lastModified: row.updatedAt.toISOString(), attachments: [],
    };
  },
  // A draft sent (web-mail release 3) is printed with the CRM row that holds it (found by its Graph id): what was sent
  // and its files (name, inline / content-id, size).
  sendDraft: async (account, draftId) => {
    const row = await prisma.emailMessage.findFirst({ where: { graphId: draftId, accountId: account.id } });
    if (!row) throw new Error(`e2e-send-jobs: no CRM row for draft ${draftId}`);
    const draftFiles = (Array.isArray(row.draftFiles) ? row.draftFiles : []).map((f) => {
      const file = f as { name?: unknown; inline?: unknown; contentId?: unknown; size?: unknown };
      return { name: file.name, inline: file.inline === true, contentId: file.contentId ?? null, size: file.size };
    });
    console.log(`e2e-sent: ${JSON.stringify({
      kind: 'draft', graphId: draftId, to: row.toAddresses, cc: row.ccAddresses, bcc: row.bccAddresses, subject: row.subject, html: row.bodyHtml ?? '', draftFiles,
    })}`);
  },
};

try {
  // The Undo window (and a scheduled time) holds a send job back: run every queued one now.
  await prisma.job.updateMany({ where: { type: 'send_user_email', status: 'queued' }, data: { runAt: new Date() } });
  let n = 0;
  while (await runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph, log: console.error })) n++;
  console.log(`e2e: ${n} send job(s) run`);
} finally {
  await prisma.$disconnect();
}
