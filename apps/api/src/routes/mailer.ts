import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type EmailCampaign, type EmailCampaignRecipient } from '@prisma/client';
import { MailerCheck, MailerCreate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight, type AuthUser } from '../plugins/auth.js';
import { NotFoundError, parseBody } from '../validate.js';
import { notifyUser } from '../leads/notify.js';
import { checkRecipients } from '../mailer/rules.js';
import { copyFileTo, removeFolder, type StoredFile } from '../mail/files.js';
import { guard } from './leads.js';

type Tx = Prisma.TransactionClient;

/** MC-001 (prototype campaign ids). */
export const campaignNumber = (id: number) => `MC-${String(id).padStart(3, '0')}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isAdmin = (u: AuthUser) => u.role === 'Administrator';

/** Campaigns the user may see: their own; Administrators everyone's (owner, 22 Nov 2026). */
const visibleWhere = (u: AuthUser): Prisma.EmailCampaignWhereInput => (isAdmin(u) ? {} : { senderId: u.id });

type Stats = { total: number; queued: number; sending: number; sent: number; failed: number; skipped: number; toSend: number; replied: number };

/** Recipient ids that got a reply after their email (a received message in the sender's own mail; a flag, never content). */
async function repliedIds(c: Pick<EmailCampaign, 'senderId'>, recipients: Pick<EmailCampaignRecipient, 'id' | 'leadId' | 'status' | 'sentAt'>[]): Promise<Set<number>> {
  const sent = recipients.filter((r) => r.status === 'Sent' && r.leadId !== null && r.sentAt);
  if (sent.length === 0) return new Set();
  const replies = await prisma.emailMessage.findMany({
    where: { userId: c.senderId, status: 'received', leadId: { in: sent.map((r) => r.leadId!) } },
    select: { leadId: true, occurredAt: true },
  });
  return new Set(sent.filter((r) => replies.some((m) => m.leadId === r.leadId && m.occurredAt > r.sentAt!)).map((r) => r.id));
}

/** Stats from per-status counts (the list counts in the database; the detail counts its loaded recipients). */
function statsOf(counts: Record<string, number>, replied: number): Stats {
  const n = (s: string) => counts[s] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, queued: n('Queued'), sending: n('Sending'), sent: n('Sent'), failed: n('Failed'), skipped: n('Skipped'), toSend: total - n('Skipped'), replied };
}

function countBy(recipients: Pick<EmailCampaignRecipient, 'status'>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of recipients) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

const senderInclude = { sender: { select: { id: true, name: true } } } satisfies Prisma.EmailCampaignInclude;
const campaignInclude = {
  ...senderInclude,
  recipients: { orderBy: { position: 'asc' }, include: { lead: { select: { number: true } }, emailMessage: { select: { messageId: true } } } },
} satisfies Prisma.EmailCampaignInclude;
type FullCampaign = Prisma.EmailCampaignGetPayload<{ include: typeof campaignInclude }>;
type ListCampaign = Prisma.EmailCampaignGetPayload<{ include: typeof senderInclude }>;

/** The first Queued recipient's name, else company. */
const nextOf = (r: Pick<EmailCampaignRecipient, 'name' | 'company'> | undefined) => r?.name || r?.company || null;

function summary(c: ListCampaign, stats: Stats, next: string | null) {
  return {
    id: c.id, number: campaignNumber(c.id), name: c.name, templateName: c.templateName, sender: c.sender, status: c.status,
    pauseReason: c.pauseReason, waitReason: c.waitReason, startAt: c.startAt, nextSendAt: c.nextSendAt, createdAt: c.createdAt,
    completedAt: c.completedAt, intervalMinutes: c.intervalMinutes, workingHoursOnly: c.workingHoursOnly, stats, next,
  };
}

/**
 * The list page's stats and next recipient in three queries for all its campaigns, without loading recipients. `replied`
 * follows repliedIds exactly: a Sent recipient whose lead has a received message in the sender's mail after sent_at.
 */
async function listSummaries(rows: ListCampaign[]) {
  const ids = rows.map((c) => c.id);
  if (ids.length === 0) return [];
  const [groups, firsts, replies] = await Promise.all([
    prisma.emailCampaignRecipient.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
    prisma.$queryRaw<{ campaign_id: number; name: string; company: string }[]>`
      SELECT DISTINCT ON (campaign_id) campaign_id, name, company FROM email_campaign_recipients
      WHERE campaign_id IN (${Prisma.join(ids)}) AND status = 'Queued' ORDER BY campaign_id, position`,
    prisma.$queryRaw<{ campaign_id: number; n: number }[]>`
      SELECT r.campaign_id, COUNT(*)::int AS n FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r.campaign_id
      WHERE r.campaign_id IN (${Prisma.join(ids)}) AND r.status = 'Sent' AND r.lead_id IS NOT NULL AND r.sent_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM email_messages m WHERE m.user_id = c.sender_id AND m.status = 'received' AND m.lead_id = r.lead_id AND m.occurred_at > r.sent_at)
      GROUP BY r.campaign_id`,
  ]);
  const counts = new Map<number, Record<string, number>>();
  for (const g of groups) counts.set(g.campaignId, { ...counts.get(g.campaignId), [g.status]: g._count._all });
  const next = new Map(firsts.map((r) => [r.campaign_id, nextOf(r)]));
  const replied = new Map(replies.map((r) => [r.campaign_id, r.n]));
  return rows.map((c) => summary(c, statsOf(counts.get(c.id) ?? {}, replied.get(c.id) ?? 0), next.get(c.id) ?? null));
}

function detail(c: FullCampaign, replied: Set<number>, viewer: AuthUser) {
  return {
    ...summary(c, statsOf(countBy(c.recipients), replied.size), nextOf(c.recipients.find((r) => r.status === 'Queued'))),
    templateUpdatedAt: c.templateUpdatedAt, subject: c.subject, body: c.body, senderAddress: c.senderAddress, cc: c.cc, bcc: c.bcc,
    unsubscribeLine: c.unsubscribeLine, lawfulBasis: c.lawfulBasis, isSender: c.senderId === viewer.id,
    recipients: c.recipients.map((r) => ({
      id: r.id, leadId: r.leadId, leadNumber: r.lead?.number ?? null, name: r.name, company: r.company, to: r.toAddress,
      status: replied.has(r.id) ? 'Replied' : r.status, sentAt: r.sentAt, error: r.error, timezones: r.timezones, timezoneSource: r.timezoneSource,
      messageId: r.emailMessage?.messageId ?? null,
    })),
  };
}

async function load(user: AuthUser, rawId: string): Promise<FullCampaign> {
  const id = Number(rawId);
  const c = Number.isInteger(id) ? await prisma.emailCampaign.findFirst({ where: { id, ...visibleWhere(user) }, include: campaignInclude }) : null;
  if (!c) throw new NotFoundError();
  return c;
}

async function view(user: AuthUser, id: number) {
  const c = await load(user, String(id));
  return detail(c, await repliedIds(c, c.recipients), user);
}

const myMailbox = (userId: number) => prisma.emailAccount.findFirst({ where: { kind: 'personal', userId, status: 'connected' } });

/**
 * The Mailer (release 2C; prototype views-mailer.js): campaigns of personalised template emails to selected leads, sent
 * one by one from the sender's mailbox by the worker. Only the sender acts on a campaign.
 */
export const mailerRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [requireRight('use_email')] };

  app.post('/mailer/check', pre, async (request) => {
    const { leadIds } = parseBody(MailerCheck, request.body);
    const user = request.user!;
    const mailbox = await myMailbox(user.id);
    return { mailbox: mailbox ? { address: mailbox.address } : null, rows: await checkRecipients(prisma, user, leadIds) };
  });

  app.post('/mailer', pre, async (request, reply) => {
    const body = parseBody(MailerCreate, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const account = await myMailbox(user.id);
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      const template = await prisma.emailTemplate.findUnique({ where: { id: body.templateId }, include: { attachments: { orderBy: { id: 'asc' } } } });
      if (!template) throw new NotFoundError();
      const rows = await checkRecipients(prisma, user, body.leadIds);
      const sendable = rows.filter((r) => !r.block).length;
      if (sendable === 0) return reply.code(409).send({ error: 'nothing_to_send' });
      const startAt = body.startAt && Date.parse(body.startAt) > Date.now() ? new Date(body.startAt) : null;
      let campaignId: number | null = null;
      const id = await prisma.$transaction(async (tx) => {
        const c = await tx.emailCampaign.create({
          data: {
            name: body.name || `Mailer · ${template.name}`, templateId: template.id, templateName: template.name, templateUpdatedAt: template.updatedAt, language: template.language,
            subject: template.subject, body: template.body, bodyHtml: template.bodyHtml, senderId: user.id, accountId: account.id, senderAddress: account.address,
            cc: body.cc, bcc: body.bcc, startAt, intervalMinutes: body.intervalMinutes, workingHoursOnly: body.workingHoursOnly,
            unsubscribeLine: body.unsubscribeLine, lawfulBasis: body.lawfulBasis, status: startAt ? 'Scheduled' : 'Sending', nextSendAt: startAt ?? new Date(),
            recipients: {
              create: rows.map((r, i) => ({
                leadId: r.leadNumber ? r.leadId : null, contactId: r.contactId, toAddress: r.to, name: r.name, company: r.company,
                timezones: r.zones, timezoneSource: r.source, status: r.block ? 'Skipped' : 'Queued', error: r.block, position: i,
              })),
            },
          },
        });
        campaignId = c.id;
        // The template's pictures and attachments as queued: the campaign's own copies, so editing or deleting the
        // template later does not change what the rest of the campaign sends.
        if (template.attachments.length) {
          const files: StoredFile[] = [];
          for (const a of template.attachments) {
            files.push({ fileName: a.fileName, contentType: a.contentType, size: a.size, contentId: a.contentId, isInline: a.isInline, storagePath: await copyFileTo(a.storagePath, 'campaigns', c.id) });
          }
          await tx.emailCampaign.update({ where: { id: c.id }, data: { attachments: files as unknown as Prisma.InputJsonValue } });
        }
        const when = startAt ? `starts ${startAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'sending now';
        await notifyUser(tx, user.id, `Mailer queued · ${c.name}`, `${plural(sendable, 'email')} · ${when}`, `/mailer/${c.id}`);
        await audit(tx, { entityType: 'email_campaign', entityId: c.id, action: 'create', userId: user.id, after: { name: c.name, recipients: rows.length, queued: sendable } });
        return c.id;
      }).catch(async (e) => {
        // Copies made for a campaign that was not saved go too.
        if (campaignId !== null) await removeFolder('campaigns', campaignId);
        throw e;
      });
      return reply.code(201).send(await view(user, id));
    });
  });

  app.get('/mailer', pre, async (request) => {
    const user = request.user!;
    const rows = await prisma.emailCampaign.findMany({ where: visibleWhere(user), include: senderInclude, orderBy: { id: 'desc' }, take: 200 });
    return { items: await listSummaries(rows) };
  });

  app.get<{ Params: { id: string } }>('/mailer/:id', pre, async (request, reply) => guard(reply, async () => {
    const c = await load(request.user!, request.params.id);
    return detail(c, await repliedIds(c, c.recipients), request.user!);
  }));

  /** Sender-only actions; others who can see it (Administrators) get 403. */
  const action = (name: string, fn: (tx: Tx, c: EmailCampaign, user: AuthUser) => Promise<string | null>) =>
    app.post<{ Params: { id: string } }>(`/mailer/:id/${name}`, pre, async (request, reply) => guard(reply, async () => {
      const user = request.user!;
      const found = await load(user, request.params.id);
      if (found.senderId !== user.id) return reply.code(403).send({ error: 'forbidden' });
      const error = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM email_campaigns WHERE id = ${found.id} FOR UPDATE`;
        const c = await tx.emailCampaign.findUniqueOrThrow({ where: { id: found.id } });
        const err = await fn(tx, c, user);
        if (!err) await audit(tx, { entityType: 'email_campaign', entityId: c.id, action: 'update', userId: user.id, after: { action: name } });
        return err;
      });
      if (error) return reply.code(409).send({ error });
      return view(user, found.id);
    }));

  action('pause', async (tx, c, user) => {
    if (!['Sending', 'Scheduled'].includes(c.status)) return 'not_running';
    await tx.emailCampaign.update({ where: { id: c.id }, data: { status: 'Paused', pauseReason: `Paused by ${user.name}`, waitReason: null } });
    return null;
  });
  action('resume', async (tx, c, user) => {
    if (c.status !== 'Paused') return 'not_paused';
    const account = await tx.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
    if (!account) return 'no_mailbox';
    const scheduled = c.startAt && c.startAt > new Date();
    await tx.emailCampaign.update({
      where: { id: c.id },
      data: { status: scheduled ? 'Scheduled' : 'Sending', pauseReason: null, accountId: account.id, senderAddress: account.address, nextSendAt: scheduled ? c.startAt : new Date() },
    });
    return null;
  });
  action('start', async (tx, c) => {
    if (c.status !== 'Scheduled') return 'not_scheduled';
    await tx.emailCampaign.update({ where: { id: c.id }, data: { status: 'Sending', startAt: null, nextSendAt: new Date() } });
    return null;
  });
  action('cancel', async (tx, c, user) => {
    if (!['Sending', 'Scheduled', 'Paused'].includes(c.status)) return 'not_running';
    await tx.emailCampaignRecipient.updateMany({ where: { campaignId: c.id, status: 'Queued' }, data: { status: 'Skipped', error: 'Campaign cancelled' } });
    await tx.emailCampaign.update({ where: { id: c.id }, data: { status: 'Cancelled', completedAt: new Date(), cancelledById: user.id, waitReason: null } });
    return null;
  });
};
