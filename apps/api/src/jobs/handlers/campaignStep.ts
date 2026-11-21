import type { Job } from '@prisma/client';
import { MAILER_DAILY_LIMIT, fillTemplate, inWorkingHours } from '@dait-crm/shared';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
import { mailUser } from '../../mail/match.js';
import { recordOnLead } from '../../mail/outgoing.js';
import { notifyUser } from '../../leads/notify.js';
import { sendBlock } from '../../mailer/rules.js';
import { queueStep, startOfDayIn, startOfNextDayIn } from '../../mailer/schedule.js';
import { textToHtml } from './sendUserEmail.js';
import type { JobContext } from '../runner.js';

/** Nobody can be sent now (working hours): look again this soon. */
const RECHECK_MS = 5 * 60_000;

/** The prototype's opt-out line, in the template's language (the prototype has English only). */
const UNSUBSCRIBE: Record<string, string> = {
  en: '\n\n—\nIf you would prefer not to receive emails from DAIT Partners, reply with "unsubscribe" and we will not contact you again.',
  es: '\n\n—\nSi prefiere no recibir correos de DAIT Partners, responda con «baja» y no volveremos a contactarle.',
  fr: '\n\n—\nSi vous préférez ne plus recevoir d’e-mails de DAIT Partners, répondez « désinscription » et nous ne vous contacterons plus.',
};

/**
 * One Mailer step (release 2C): at most one email from the sender's own mailbox, then the next step is queued after the
 * campaign's interval. Recipients who can no longer be mailed (or replied) are skipped at no cost; with "working hours
 * only" a recipient outside Monday–Friday 09:00–18:00 in their time zone waits while others go; over the daily limit
 * the campaign waits for the sender's next day. A revoked or disconnected mailbox pauses the campaign.
 */
export async function campaignStepHandler(job: Job, ctx: JobContext): Promise<void> {
  const { campaignId } = job.payload as unknown as { campaignId: number };
  const now = new Date();

  // Claim the next recipient under the campaign lock, so two steps never send at once or twice.
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_campaigns WHERE id = ${campaignId} FOR UPDATE`;
    const c = await tx.emailCampaign.findUnique({ where: { id: campaignId } });
    if (!c || c.status !== 'Sending' || (c.nextSendAt && c.nextSendAt > now)) return null;

    await tx.emailCampaignRecipient.updateMany({ where: { campaignId, status: 'Sending' }, data: { status: 'Failed', error: 'Interrupted — it may have been sent' } });
    const user = await mailUser(tx, c.senderId);
    const account = await tx.emailAccount.findFirst({ where: { kind: 'personal', userId: c.senderId, status: 'connected' } });
    if (!user || !account) {
      await tx.emailCampaign.update({ where: { id: c.id }, data: { status: 'Paused', pauseReason: 'Mailbox disconnected', waitReason: null } });
      await notifyUser(tx, c.senderId, `Mailer paused · ${c.name}`, "The sender's mailbox is no longer connected.", `/mailer/${c.id}`);
      return null;
    }
    const sentToday = await tx.emailMessage.count({ where: { userId: c.senderId, campaignId: { not: null }, occurredAt: { gte: startOfDayIn(user.timezone, now) } } });
    if (sentToday >= MAILER_DAILY_LIMIT) {
      await tx.emailCampaign.update({ where: { id: c.id }, data: { waitReason: 'daily_limit', nextSendAt: startOfNextDayIn(user.timezone, now) } });
      return { wait: true, c, user } as const;
    }
    const queued = await tx.emailCampaignRecipient.findMany({ where: { campaignId, status: 'Queued' }, orderBy: { position: 'asc' } });
    let waiting = false;
    for (const r of queued) {
      const block = await sendBlock(tx, user, r.leadId, c.createdAt, { toAddress: r.toAddress, contactId: r.contactId });
      if (block) {
        await tx.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Skipped', error: block } });
        continue;
      }
      if (c.workingHoursOnly && !inWorkingHours(r.timezones, now)) {
        waiting = true;
        continue;
      }
      await tx.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Sending' } });
      await tx.emailCampaign.update({ where: { id: c.id }, data: { waitReason: null, nextSendAt: new Date(now.getTime() + c.intervalMinutes * 60_000), accountId: account.id } });
      return { wait: false, c, user, account, r } as const;
    }
    if (waiting) {
      await tx.emailCampaign.update({ where: { id: c.id }, data: { waitReason: 'working_hours', nextSendAt: new Date(now.getTime() + RECHECK_MS) } });
      return { wait: true, c, user } as const;
    }
    return { wait: true, c, user, done: true } as const;
  });
  if (!claimed) return;
  if (claimed.wait) {
    if ('done' in claimed) return finishCampaign(campaignId);
    const next = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (next.nextSendAt) await queueStep(prisma, campaignId, next.nextSendAt, job.id);
    return;
  }

  const { c, user, account, r } = claimed;
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.leadId! }, include: { contact: { select: { firstName: true } } } });
  const ctxFill = { firstName: lead.contact?.firstName || 'there', company: lead.companyName, me: user.name, leadNumber: lead.number };
  const language = (await prisma.emailTemplate.findUnique({ where: { id: c.templateId ?? -1 }, select: { language: true } }))?.language ?? 'en';
  const subject = fillTemplate(c.subject, ctxFill).slice(0, 500);
  const text = fillTemplate(c.body, ctxFill) + (c.unsubscribeLine ? (UNSUBSCRIBE[language] ?? UNSUBSCRIBE.en) : '');
  try {
    await ctx.graph.sendMail(account, {
      to: [r.toAddress], ...(c.cc.length ? { cc: c.cc } : {}), ...(c.bcc.length ? { bcc: c.bcc } : {}), subject, html: textToHtml(text), text,
    });
  } catch (err) {
    const reason = errorMessage(err);
    if (isAuthFailure(err)) {
      await prisma.$transaction(async (tx) => {
        await tx.emailAccount.updateMany({ where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc }, data: { status: 'error', lastError: reason } });
        // The sender may have paused or cancelled while the send was in flight: that choice stands.
        await tx.$queryRaw`SELECT id FROM email_campaigns WHERE id = ${c.id} FOR UPDATE`;
        const now = await tx.emailCampaign.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } });
        if (now.status === 'Cancelled') {
          await tx.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Skipped', error: 'Campaign cancelled' } });
          return;
        }
        await tx.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Queued' } });
        if (now.status !== 'Sending') return;
        await tx.emailCampaign.update({ where: { id: c.id }, data: { status: 'Paused', pauseReason: 'Mailbox needs reconnecting', waitReason: null } });
        await notifyUser(tx, c.senderId, `Mailer paused · ${c.name}`, 'Your Microsoft 365 mailbox needs reconnecting in Settings.', `/mailer/${c.id}`);
      });
      return;
    }
    await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Failed', error: reason } });
    return afterSend(c.id, job.id);
  }

  await prisma.$transaction(async (tx) => {
    const msg = await tx.emailMessage.create({
      data: {
        userId: c.senderId, accountId: account.id, leadId: lead.id, contactId: lead.contactId, companyId: lead.companyId, campaignId: c.id,
        folder: 'sent', status: 'sent', source: 'crm', fromAddress: account.address, toAddresses: [r.toAddress], ccAddresses: c.cc, bccAddresses: c.bcc,
        subject, bodyText: text, occurredAt: new Date(),
      },
    });
    await recordOnLead(tx, user, lead, msg, subject);
    await tx.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: 'Sent', sentAt: msg.occurredAt, emailMessageId: msg.id, error: null } });
  });
  return afterSend(c.id, job.id);
}

/** After a send or a failure: complete the campaign, or queue its next step. */
async function afterSend(campaignId: number, fromJobId: number): Promise<void> {
  const left = await prisma.emailCampaignRecipient.count({ where: { campaignId, status: 'Queued' } });
  if (left === 0) return finishCampaign(campaignId);
  const c = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (c.status === 'Sending' && c.nextSendAt) await queueStep(prisma, campaignId, c.nextSendAt, fromJobId);
}

async function finishCampaign(campaignId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_campaigns WHERE id = ${campaignId} FOR UPDATE`;
    const c = await tx.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (c.status !== 'Sending' || (await tx.emailCampaignRecipient.count({ where: { campaignId, status: { in: ['Queued', 'Sending'] } } })) > 0) return;
    await tx.emailCampaign.update({ where: { id: campaignId }, data: { status: 'Completed', completedAt: new Date(), waitReason: null, nextSendAt: null } });
    const count = (status: string) => tx.emailCampaignRecipient.count({ where: { campaignId, status } });
    const [sent, skipped, failed] = [await count('Sent'), await count('Skipped'), await count('Failed')];
    await notifyUser(tx, c.senderId, `Mailer finished · ${c.name}`, `${sent} sent · ${skipped} skipped · ${failed} failed`, `/mailer/${c.id}`);
  });
}
