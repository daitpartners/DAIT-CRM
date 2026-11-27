import { createHash } from 'node:crypto';
import type { EmailAccount, EmailMessage, Prisma } from '@prisma/client';
import {
  TEMPLATE_ATTACHMENTS_MAX_BYTES, TEMPLATE_ATTACHMENTS_MAX_COUNT, localNow, replyRecipients, replySubject, resolveTimezones,
  type DraftAttachmentUpload, type DraftCreate, type DraftSave, type DraftTemplateApply,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { GraphError, type DraftFields, type GraphAttachment, type GraphClient, type MailAttachment } from '../graph/client.js';
import type { AuthUser } from '../plugins/auth.js';
import { companyWhere } from '../companies/visibility.js';
import { assertLeadVisible, canSeeLead, leadWhere } from '../leads/visibility.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { MailAccessError, canSeeTeamMail, messageFor } from './access.js';
import { processEmailBody } from './bodies.js';
import { MailChangeError, outlookFailure } from './changes.js';
import { AttachmentError, checkUpload, cidsShown, cleanCid, sniff, storedAttachment } from './files.js';
import { outgoingBody } from './formatted.js';
import { textToHtml } from './html.js';
import { leadPanel, type LeadPanel } from './leadPanel.js';
import { participantsOf } from './leadMail.js';
import { assertProjectFor } from './outgoing.js';
import { templateFiles } from './templateFiles.js';

/**
 * Drafts in the user's own Outlook (web-mail release 3, plan decisions 2, 9, 11, 15, 20). Every message being written
 * is an Outlook draft in the caller's own connected personal mailbox: created here (new, reply, reply all, forward),
 * saved over on every auto-save (last save wins), discarded, and sent later (Task 8). A reply keeps the folded quote
 * Graph gives the reply draft, sanitised, in `quoted_html`, and appends it to the user's part on every save. Another
 * user's draft or message is 403 view_only (team view) or 404; nothing about the mail (subject, body, addresses) is
 * ever logged.
 */

/** A draft request refused, answered as `{ error: code }` with `status` (app.ts error handler). */
export class DraftError extends Error {
  constructor(
    readonly code: 'no_mailbox' | 'draft_gone' | 'not_draft' | 'no_recipients' | 'schedule_time' | 'follow_up_time' | 'already_sent',
    readonly status: 400 | 409,
  ) {
    super(code);
    this.name = 'DraftError';
  }
}

/** Characters of the folded quote kept as HTML; a longer quote is kept as its text (simple HTML). */
export const QUOTE_MAX = 200_000;

/** How many recipient suggestions a search gives. */
const SUGGESTIONS_MAX = 8;

/** A draft's statuses the editor may open and save: a draft, or a send that failed (saving makes it a draft again). */
const EDITABLE = ['draft', 'failed'];

/** One recipient chip: the address, and who it is when the CRM knows (a contact's or lead's name, the lead's number). */
export type Recipient = { address: string; name: string | null; leadNumber: string | null };

/**
 * A file on the Outlook draft (plan decisions 7 and 8), listed in `email_messages.draft_files` (`attachment_names` keeps
 * the non-inline names): `id` is the Graph attachment id; an inline picture has the content-id its HTML shows as
 * `cid:`. Uploaded from the CRM, copied from a template (`fromTemplate`, replaced when another template is applied),
 * or already on the draft in Outlook (a forward's original attachments, a quote's pictures, a draft made in Outlook).
 * The bytes are never stored by the CRM.
 */
export interface DraftFile { id: string; name: string; contentType: string; size: number; inline: boolean; contentId: string | null; fromTemplate?: true }
/** A draft file as the editor gets it: `dataUrl` (`data:<type>;base64,…`) only for inline pictures, so the editor can show them. */
export type DraftFileView = Omit<DraftFile, 'contentId' | 'fromTemplate'> & { contentId: string | null; dataUrl: string | null };

/** What the editor opens: the draft, its recipients named, the lead summary and the recipient's time zone. */
export interface DraftView {
  id: number;
  replyToId: number | null;
  from: string;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  bodyHtml: string;
  quotedHtml: string | null;
  files: DraftFileView[];
  leadId: number | null;
  projectId: number | null;
  lead: LeadPanel | null;
  recipientZone: { zone: string; label: string } | null;
  savedAt: string;
  status: string;
  scheduledAt: string | null;
}

/** The caller's connected personal mailbox, else DraftError no_mailbox (409). */
export async function myAccount(userId: number): Promise<EmailAccount> {
  const account = await prisma.emailAccount.findFirst({ where: { kind: 'personal', userId, status: 'connected' } });
  if (!account) throw new DraftError('no_mailbox', 409);
  return account;
}

/** The signature as the start of a new message: an empty line, then the signature; '' for none. */
export function signatureBlock(html: string | null): string {
  return html ? `<p><br></p><div class="dait-sig">${html}</div>` : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26 Nov 2026, 14:05": 24-hour, in `timezone` (UTC for an unknown zone). */
function sentAt(at: Date, timezone: string): string {
  const { day, time } = localNow(timezone, at);
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}, ${time}`;
}

/**
 * The header of a quoted or forwarded message only the CRM has (no Graph id): From, Sent (in `timezone`, the
 * sender's), To and Subject, one per line, as plain text.
 */
export function quoteHeader(original: EmailMessage, timezone: string): string {
  const from = original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress;
  return [
    `From: ${from}`, `Sent: ${sentAt(original.occurredAt, timezone)}`, `To: ${(original.toAddresses as string[]).join(', ')}`,
    `Subject: ${original.subject}`,
  ].join('\n');
}

/**
 * HTML from Outlook (a reply draft's quote, a draft made in Outlook) as the CRM keeps and sends it: through the
 * outgoing sanitiser, whole; over `max` characters, or unreadable, its text as simple HTML.
 */
async function sanitisedWhole(html: string, max: number, cids: string[] = []): Promise<{ html: string; text: string }> {
  if (!html.trim()) return { html: '', text: '' };
  const r = await processEmailBody({ contentType: 'html', content: html }, max, { outgoing: true, whole: true, ...(cids.length ? { cids } : {}) });
  if (!r.fellBack && r.bodyHtml !== null && r.bodyHtml.length <= max) return { html: r.bodyHtml, text: r.bodyText };
  const text = r.bodyText.slice(0, max);
  return { html: text ? textToHtml(text) : '', text };
}

/** A Graph refusal meaning the draft is no longer one in Outlook: deleted (404) or sent there (getDraft's not_a_draft). */
const isGone = (err: unknown) => err instanceof GraphError && (err.status === 404 || (err.status === 409 && err.message === 'not_a_draft'));

/** Runs an Outlook call on a draft: gone → DraftError draft_gone (409); any other failure → outlookFailure. */
async function onDraft<T>(account: EmailAccount, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isGone(err)) throw new DraftError('draft_gone', 409);
    return outlookFailure(account, err);
  }
}

/** Runs any other Outlook call; every failure → outlookFailure. */
async function inOutlook<T>(account: EmailAccount, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    return outlookFailure(account, err);
  }
}

const lower = (list: readonly string[]) => [...new Set(list.map((a) => a.trim().toLowerCase()).filter(Boolean))];

/**
 * The caller's own draft for a drafts route. Another user's message or draft is 403 view_only for a team-mail reader
 * (drafts are never team-readable, but the drafts routes still answer "view only" rather than "no such message"), else 404.
 */
export async function draftFor(user: AuthUser, rawId: string): Promise<EmailMessage> {
  try {
    return (await messageFor(prisma, user, rawId, 'change')).m;
  } catch (err) {
    if (err instanceof NotFoundError && canSeeTeamMail(user) && /^\d{1,9}$/.test(rawId)) {
      const other = await prisma.emailMessage.findFirst({ where: { id: Number(rawId), userId: { not: user.id }, folder: 'drafts' }, select: { id: true } });
      if (other) throw new MailAccessError('view_only');
    }
    throw err;
  }
}

/** A draft the editor may open or save (folder drafts, status draft or failed), else 409 not_draft. */
function assertEditable(m: EmailMessage): void {
  if (m.folder !== 'drafts' || !EDITABLE.includes(m.status)) throw new DraftError('not_draft', 409);
}

/**
 * Starts a draft in the caller's own Outlook and its CRM row. `new`: an empty draft (the signature when Add
 * automatically is on), on the lead and project given (lead visible; project of the lead's company). Reply, reply all,
 * forward of `replyToId` (the caller's own message, not a draft): Graph's reply draft of the original when it is in
 * the caller's mailbox, with the shared recipients and subject written over Outlook's, and its quote kept sanitised;
 * an original only the CRM has gets a new draft quoting the stored message.
 */
export async function createDraft(graph: GraphClient, user: AuthUser, body: DraftCreate): Promise<EmailMessage> {
  const me = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { signatureHtml: true, signatureAuto: true } });
  const userPart = me.signatureAuto ? signatureBlock(me.signatureHtml) : '';

  if (body.kind === 'new') {
    const account = await myAccount(user.id);
    const lead = body.leadId ? await assertLeadVisible(prisma, user, body.leadId) : null;
    if (body.projectId) await assertProjectFor(prisma, user, body.projectId, lead?.companyId ?? null);
    const fields: DraftFields = { subject: '', html: userPart, to: [], cc: [], bcc: [], from: account.sendAs };
    const d = await inOutlook(account, () => graph.createDraft(account, fields));
    return prisma.emailMessage.create({
      data: {
        ...rowOf(user, account, d.id, d.conversationId, fields, userPart, null),
        leadId: lead?.id ?? null, companyId: lead?.companyId ?? null, contactId: lead?.contactId ?? null, projectId: body.projectId ?? null,
      },
    });
  }

  const { m: original } = await messageFor(prisma, user, String(body.replyToId), 'change');
  if (original.status === 'draft' || original.folder === 'drafts') throw new MailChangeError('draft', 409);
  const account = await myAccount(user.id);
  const own = lower([account.address, ...(account.sendAs ? [account.sendAs] : [])]);
  const { to } = replyRecipients({ ...original, toAddresses: original.toAddresses as string[] }, body.kind, own, []);
  const cc = body.kind === 'replyAll' ? lower(original.ccAddresses as string[]).filter((a) => !own.includes(a)) : [];
  const subject = replySubject(original.subject, body.kind);

  let draftId: string;
  let conversationId: string | null;
  let quotedHtml: string;
  let fields: DraftFields;
  let files: DraftFile[] = [];
  if (original.graphId && original.accountId === account.id) {
    const graphId = original.graphId;
    const d = await inOutlook(account, () => graph.createReplyDraft(account, graphId, body.kind as 'reply' | 'replyAll' | 'forward'));
    // The files Outlook put on the draft (a forward's attachments, the quote's pictures), so their cid: pictures stay.
    files = (await onDraft(account, () => graph.getDraft(account, d.id))).attachments.map((a) => fileOfGraph(a));
    quotedHtml = (await sanitisedWhole(d.html, QUOTE_MAX, cidsOf(files))).html;
    fields = { subject, html: userPart + quotedHtml, to, cc, bcc: [], from: account.sendAs };
    // Outlook holds exactly what the CRM shows: the shared recipients and subject, the user part and the sanitised quote.
    await onDraft(account, () => graph.updateDraft(account, d.id, fields));
    draftId = d.id;
    conversationId = d.conversationId ?? original.threadId;
  } else {
    const stored = original.bodyHtml || textToHtml(original.bodyText);
    const header = textToHtml(quoteHeader(original, user.timezone));
    quotedHtml = (await sanitisedWhole(`<hr><div id="divRplyFwdMsg">${header}</div><br>${stored}`, QUOTE_MAX)).html;
    fields = { subject, html: userPart + quotedHtml, to, cc, bcc: [], from: account.sendAs };
    const d = await inOutlook(account, () => graph.createDraft(account, fields));
    draftId = d.id;
    conversationId = original.threadId;
  }
  const leadId = original.leadId !== null && (await canSeeLead(prisma, user, original.leadId)) ? original.leadId : null;
  return prisma.emailMessage.create({
    data: {
      ...rowOf(user, account, draftId, conversationId, fields, userPart, quotedHtml),
      ...filesData(files),
      replyToId: original.id, leadId, companyId: original.companyId, contactId: original.contactId, projectId: original.projectId,
    },
  });
}

/** The CRM row of a new draft: the user part as its body, the quote apart. */
function rowOf(
  user: AuthUser, account: EmailAccount, graphId: string, threadId: string | null, f: DraftFields, bodyHtml: string, quotedHtml: string | null,
) {
  return {
    userId: user.id, accountId: account.id, folder: 'drafts', status: 'draft', source: 'crm', graphId, threadId,
    fromAddress: account.sendAs ?? account.address, toAddresses: f.to, ccAddresses: f.cc, bccAddresses: f.bcc, subject: f.subject,
    bodyHtml, bodyText: '', quotedHtml,
  } satisfies Prisma.EmailMessageUncheckedCreateInput;
}

const filesOf = (m: Pick<EmailMessage, 'draftFiles'>) => (m.draftFiles as unknown as DraftFile[]) ?? [];

/** The `draft_files` and `attachment_names` (non-inline names) columns for a draft's files. */
const filesData = (files: DraftFile[]) => ({
  draftFiles: files as unknown as Prisma.InputJsonValue,
  attachmentNames: files.filter((f) => !f.inline).map((f) => f.name),
});

/** Every content-id of the draft's files: the only `cid:` pictures its HTML keeps. */
const cidsOf = (files: DraftFile[]) => files.flatMap((f) => (f.contentId ? [f.contentId] : []));

/** A file Graph lists on the draft as a draft file (a template file applied before keeps its mark). */
function fileOfGraph(a: GraphAttachment, before?: DraftFile): DraftFile {
  return {
    id: a.id, name: a.name.trim() || 'attachment', contentType: a.contentType, size: a.size, inline: a.isInline, contentId: cleanCid(a.contentId),
    ...(before?.fromTemplate ? { fromTemplate: true as const } : {}),
  };
}

/** A picture's bytes as a data URL, when they are a picture sniff() knows (the type from the bytes, never Graph's). */
function pictureUrl(data: Buffer, name: string): string | null {
  const kind = sniff(data, name);
  return kind?.image ? `data:${kind.contentType};base64,${data.toString('base64')}` : null;
}

const viewOf = (f: DraftFile, dataUrl: string | null): DraftFileView => ({
  id: f.id, name: f.name, contentType: f.contentType, size: f.size, inline: f.inline, contentId: f.contentId, dataUrl: f.inline ? dataUrl : null,
});

/**
 * The draft's files for the editor: each inline picture read from the Outlook draft (capped at
 * TEMPLATE_ATTACHMENTS_MAX_BYTES) as a data URL; `dataUrl: null` when it cannot be read or is not a known picture.
 */
async function fileViews(graph: GraphClient | undefined, user: AuthUser, m: EmailMessage): Promise<DraftFileView[]> {
  const files = filesOf(m);
  const graphId = m.graphId;
  if (!graph || !graphId || !files.some((f) => f.inline)) return files.map((f) => viewOf(f, null));
  const account = await prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
  return Promise.all(files.map(async (f) => {
    if (!f.inline || !account) return viewOf(f, null);
    try {
      return viewOf(f, pictureUrl(await graph.attachmentContent(account, graphId, f.id, TEMPLATE_ATTACHMENTS_MAX_BYTES), f.name));
    } catch {
      return viewOf(f, null);
    }
  }));
}

/** The draft as the editor opens it (see DraftView); with `graph`, its inline pictures as data URLs. */
export async function draftView(user: AuthUser, m: EmailMessage, graph?: GraphClient): Promise<DraftView> {
  const to = m.toAddresses as string[];
  const cc = m.ccAddresses as string[];
  const bcc = m.bccAddresses as string[];
  const visibleLead = m.leadId !== null && (await canSeeLead(prisma, user, m.leadId)) ? m.leadId : null;
  const [named, lead, recipientZone, files] = await Promise.all([
    resolveRecipients(user, [...to, ...cc, ...bcc]),
    visibleLead !== null ? leadPanel(prisma, user, visibleLead, participantsOf({ from: m.fromAddress, to, cc, bcc })) : null,
    visibleLead !== null ? recipientZoneOf(visibleLead, user.timezone) : null,
    fileViews(graph, user, m),
  ]);
  const byAddress = new Map(named.map((r) => [r.address, r]));
  const chips = (list: string[]) => list.map((a) => byAddress.get(a.trim().toLowerCase()) ?? { address: a, name: null, leadNumber: null });
  return {
    id: m.id, replyToId: m.replyToId, from: m.fromAddress, to: chips(to), cc: chips(cc), bcc: chips(bcc), subject: m.subject,
    bodyHtml: m.bodyHtml ?? '', quotedHtml: m.quotedHtml, files,
    leadId: m.leadId, projectId: m.projectId, lead, recipientZone, savedAt: m.updatedAt.toISOString(), status: m.status,
    scheduledAt: m.scheduledAt?.toISOString() ?? null,
  };
}

/**
 * The lead's company's time zone when it gives one zone that is not the sender's (plan decision 19), labelled with the
 * zone's city ("America/Chicago" → "Chicago"). A company with no zone, state or city falls back to the lead's city.
 */
async function recipientZoneOf(leadId: number, senderZone: string): Promise<{ zone: string; label: string } | null> {
  const l = await prisma.lead.findUnique({
    where: { id: leadId }, select: { country: true, city: true, company: { select: { timezone: true, country: true, state: true, city: true } } },
  });
  if (!l) return null;
  const co = l.company;
  const { zones } = resolveTimezones(
    co && (co.timezone || co.state || co.city)
      ? { companyTimezone: co.timezone, country: co.country, state: co.state, city: co.city }
      : { country: co?.country ?? l.country, state: null, city: l.city },
    senderZone,
  );
  const zone = zones.length === 1 ? zones[0]! : null;
  if (!zone || zone === senderZone) return null;
  return { zone, label: zone.split('/').pop()!.replace(/_/g, ' ') };
}

/**
 * Opens the caller's own draft (status draft, or a failed send). A CRM draft is shown from its row; a draft made in
 * Outlook is read fresh from Graph (whole body editable, no fold, its files listed so their cid: pictures stay) and its
 * row updated. Inline pictures come as data URLs. Gone in Outlook → draft_gone.
 */
export async function openDraft(graph: GraphClient, user: AuthUser, m: EmailMessage): Promise<DraftView> {
  assertEditable(m);
  if (m.source !== 'sync') return draftView(user, m, graph);
  const account = await myAccount(user.id);
  if (!m.graphId) throw new DraftError('draft_gone', 409);
  const graphId = m.graphId;
  const d = await onDraft(account, () => graph.getDraft(account, graphId));
  const before = new Map(filesOf(m).map((f) => [f.id, f]));
  const files = d.attachments.map((a) => fileOfGraph(a, before.get(a.id)));
  const body = await sanitisedWhole(d.html, QUOTE_MAX, cidsOf(files));
  const fresh = await prisma.emailMessage.update({
    where: { id: m.id },
    data: {
      subject: d.subject.slice(0, 500), toAddresses: d.to, ccAddresses: d.cc, bccAddresses: d.bcc, bodyHtml: body.html, bodyText: body.text,
      quotedHtml: null, threadId: d.conversationId ?? m.threadId, ...filesData(files),
    },
  });
  return draftView(user, fresh, graph);
}

/** The user's part of a draft, sanitised for sending; an empty one (or one sanitising empties) is an empty draft. */
async function userPartOf(bodyHtml: string, cids: string[]): Promise<{ html: string; text: string }> {
  if (!bodyHtml.trim()) return { html: '', text: '' };
  try {
    const r = await outgoingBody(undefined, bodyHtml, cids);
    return r.formatted ? { html: r.formatted.html, text: r.formatted.text } : { html: textToHtml(r.body), text: r.body };
  } catch (err) {
    // outgoingBody's "Enter a message": nothing readable is left, which a draft may be.
    if (err instanceof ValidationError) return { html: '', text: '' };
    throw err;
  }
}

/**
 * Saves the caller's own draft (auto-save; last save wins): the user part sanitised, Outlook updated with it and the
 * folded quote, then the row (a failed send becomes a draft again). The lead and project are checked again when they
 * change. Gone in Outlook → draft_gone, and the row is left as it was.
 */
export async function saveDraft(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftSave): Promise<{ savedAt: string }> {
  assertEditable(m);
  const account = await myAccount(user.id);
  if (!m.graphId) throw new DraftError('draft_gone', 409);
  const graphId = m.graphId;

  let { leadId, companyId, contactId, projectId } = m;
  if (body.leadId !== undefined && body.leadId !== m.leadId) {
    if (body.leadId === null) {
      leadId = null;
    } else {
      const lead = await assertLeadVisible(prisma, user, body.leadId);
      ({ id: leadId, companyId, contactId } = lead);
    }
  }
  if (body.projectId !== undefined) projectId = body.projectId;
  if (projectId !== null && (projectId !== m.projectId || leadId !== m.leadId)) await assertProjectFor(prisma, user, projectId, companyId);

  const files = filesOf(m);
  const part = await userPartOf(body.bodyHtml, cidsOf(files));
  const html = part.html + (m.quotedHtml ?? '');
  await onDraft(account, () => graph.updateDraft(account, graphId, {
    subject: body.subject, html, to: body.to, cc: body.cc, bcc: body.bcc, from: account.sendAs,
  }));
  const savedAt = new Date();
  const saved = await prisma.emailMessage.updateMany({
    where: { id: m.id, userId: user.id, folder: 'drafts', status: { in: EDITABLE } },
    data: {
      toAddresses: body.to, ccAddresses: body.cc, bccAddresses: body.bcc, subject: body.subject, bodyHtml: part.html, bodyText: part.text,
      leadId, companyId, contactId, projectId, status: 'draft', lastError: null, updatedAt: savedAt,
    },
  });
  // Sent or discarded meanwhile (another tab): the save did not land on a draft.
  if (saved.count === 0) throw new DraftError('not_draft', 409);
  await detachRemovedPictures(graph, account, m, files, html);
  return { savedAt: savedAt.toISOString() };
}

/**
 * Inline pictures the saved draft showed and its new HTML no longer shows (removed in the editor) are taken off the
 * Outlook draft and out of its files. Only pictures shown before go: one uploaded while this save was on its way is
 * kept. A removal Outlook refuses leaves the file listed (the save itself has landed).
 */
async function detachRemovedPictures(graph: GraphClient, account: EmailAccount, m: EmailMessage, files: DraftFile[], html: string): Promise<void> {
  const before = cidsShown(`${m.bodyHtml ?? ''}${m.quotedHtml ?? ''}`);
  const now = cidsShown(html);
  const gone = files.filter((f) => f.inline && f.contentId && before.has(f.contentId.toLowerCase()) && !now.has(f.contentId.toLowerCase()));
  if (!gone.length) return;
  const removed = new Set<string>();
  for (const f of gone) {
    try {
      await graph.removeAttachment(account, m.graphId!, f.id);
      removed.add(f.id);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) removed.add(f.id);
    }
  }
  if (removed.size) await changeFiles(m.id, (list) => list.filter((f) => !removed.has(f.id)));
}

/**
 * Changes the draft's file list under a row lock (an upload, a removal and a save can overlap), keeping
 * `attachment_names` in step; returns the new list.
 */
async function changeFiles(id: number, change: (files: DraftFile[]) => DraftFile[]): Promise<DraftFile[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_messages WHERE id = ${id} FOR UPDATE`;
    const row = await tx.emailMessage.findUniqueOrThrow({ where: { id }, select: { draftFiles: true } });
    const files = change(filesOf(row));
    await tx.emailMessage.update({ where: { id }, data: filesData(files) });
    return files;
  });
}

/** Too many files on a draft: 422 attachment_invalid. */
const tooMany = () => new AttachmentError('attachment_invalid', 422);

/** The caller's own editable draft with its Outlook id and mailbox, for a file change. */
async function draftInOutlook(user: AuthUser, m: EmailMessage): Promise<{ account: EmailAccount; graphId: string }> {
  assertEditable(m);
  const account = await myAccount(user.id);
  if (!m.graphId) throw new DraftError('draft_gone', 409);
  return { account, graphId: m.graphId };
}

/** Puts one file on the Outlook draft and lists it (at most TEMPLATE_ATTACHMENTS_MAX_COUNT; past it the upload is taken off again). */
async function attach(graph: GraphClient, account: EmailAccount, m: EmailMessage, graphId: string, a: MailAttachment, file: Omit<DraftFile, 'id'>): Promise<DraftFile> {
  const { id } = await onDraft(account, () => graph.addAttachment(account, graphId, a));
  const added: DraftFile = { id, ...file };
  let over = false;
  await changeFiles(m.id, (list) => {
    over = list.length >= TEMPLATE_ATTACHMENTS_MAX_COUNT;
    return over ? list : [...list, added];
  });
  if (over) {
    await graph.removeAttachment(account, graphId, id).catch(() => undefined);
    throw tooMany();
  }
  return added;
}

/**
 * Uploads a file to the caller's own Outlook draft (plan decision 7): checked by its bytes (checkUpload: a known type,
 * an inline one a picture, at most TEMPLATE_ATTACHMENTS_MAX_BYTES), at most TEMPLATE_ATTACHMENTS_MAX_COUNT files per
 * draft. An inline picture (decision 8) gets the content-id `img-<first 16 hex of its sha256>@dait`; the same picture
 * again is the file already there.
 */
export async function addDraftFile(graph: GraphClient, user: AuthUser, m: EmailMessage, upload: DraftAttachmentUpload): Promise<DraftFileView> {
  const { account, graphId } = await draftInOutlook(user, m);
  const checked = checkUpload(upload);
  const dataUrl = upload.inline ? `data:${checked.contentType};base64,${checked.data.toString('base64')}` : null;
  const contentId = upload.inline ? `img-${createHash('sha256').update(checked.data).digest('hex').slice(0, 16)}@dait` : null;
  const files = filesOf(m);
  const same = contentId ? files.find((f) => f.inline && f.contentId === contentId) : undefined;
  if (same) return viewOf(same, dataUrl);
  if (files.length >= TEMPLATE_ATTACHMENTS_MAX_COUNT) throw tooMany();
  const contentBase64 = checked.data.toString('base64');
  const added = await attach(
    graph, account, m, graphId,
    { name: checked.fileName, contentType: checked.contentType, contentBase64, ...(contentId ? { isInline: true, contentId } : {}) },
    { name: checked.fileName, contentType: checked.contentType, size: checked.size, inline: upload.inline, contentId },
  );
  return viewOf(added, dataUrl);
}

/** Takes a file off the caller's own Outlook draft (already gone there is fine); a file the draft does not list is 404. */
export async function removeDraftFile(graph: GraphClient, user: AuthUser, m: EmailMessage, fileId: string): Promise<void> {
  const { account, graphId } = await draftInOutlook(user, m);
  if (!filesOf(m).some((f) => f.id === fileId)) throw new NotFoundError();
  await removeFromOutlook(graph, account, graphId, fileId);
  await changeFiles(m.id, (list) => list.filter((f) => f.id !== fileId));
}

/** Removes an attachment from the Outlook draft: 404 (already gone, or the draft is) is fine; any other failure → outlookFailure. */
async function removeFromOutlook(graph: GraphClient, account: EmailAccount, graphId: string, fileId: string): Promise<void> {
  try {
    await graph.removeAttachment(account, graphId, fileId);
  } catch (err) {
    if (!(err instanceof GraphError && err.status === 404)) await outlookFailure(account, err);
  }
}

/**
 * Copies a template's files onto the caller's own Outlook draft: its inline pictures (with the template's own
 * content-ids, which the template's HTML shows) and the attachments the sender kept (templateFiles: one no longer of
 * the template is 409 template_files_missing). Every file is read before the draft changes; the files of a template
 * applied before are taken off first. At most TEMPLATE_ATTACHMENTS_MAX_COUNT files on the draft (422).
 */
export async function applyTemplateFiles(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftTemplateApply): Promise<DraftFileView[]> {
  const { account, graphId } = await draftInOutlook(user, m);
  const stored = await templateFiles(body.templateId, body.attachmentIds);
  const read = await Promise.all(stored.map(async (f) => ({ f, a: await storedAttachment(f) })));
  const previous = filesOf(m).filter((f) => f.fromTemplate);
  if (filesOf(m).length - previous.length + read.length > TEMPLATE_ATTACHMENTS_MAX_COUNT) throw tooMany();
  for (const f of previous) await removeFromOutlook(graph, account, graphId, f.id);
  const old = new Set(previous.map((f) => f.id));
  if (old.size) await changeFiles(m.id, (list) => list.filter((f) => !old.has(f.id)));
  const views: DraftFileView[] = [];
  for (const { f, a } of read) {
    const inline = f.isInline && !!f.contentId;
    const added = await attach(graph, account, m, graphId, a, {
      name: f.fileName, contentType: f.contentType, size: f.size, inline, contentId: inline ? f.contentId : null, fromTemplate: true,
    });
    views.push(viewOf(added, inline ? pictureUrl(Buffer.from(a.contentBase64, 'base64'), f.fileName) : null));
  }
  return views;
}

/** Discards the caller's own draft: deleted in Outlook (already gone there is fine), then the row. */
export async function discardDraft(graph: GraphClient, user: AuthUser, m: EmailMessage): Promise<void> {
  assertEditable(m);
  if (m.graphId) {
    const account = await myAccount(user.id);
    const graphId = m.graphId;
    try {
      await graph.deleteMessage(account, graphId);
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 404)) await outlookFailure(account, err);
    }
  }
  await prisma.emailMessage.deleteMany({ where: { id: m.id, userId: user.id, folder: 'drafts', status: { in: EDITABLE } } });
}

/** `%text%` for ILIKE (Prisma `contains` does not escape), with ILIKE's own wildcards matched literally. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Recipients from the contacts (of companies the user can see) and leads (leadWhere) matching `contact` / `lead`,
 * with an email address: contacts first, one per address, the newest visible lead's number on each.
 */
async function people(user: AuthUser, contact: Prisma.ContactWhereInput, lead: Prisma.LeadWhereInput, take?: number): Promise<Recipient[]> {
  const visibleLeads = leadWhere(user);
  const [contacts, leads] = await Promise.all([
    prisma.contact.findMany({
      where: { AND: [{ company: companyWhere(user) }, { isActive: true }, { businessEmail: { not: null } }, contact] },
      select: { firstName: true, lastName: true, businessEmail: true, leads: { where: visibleLeads, select: { number: true }, orderBy: { id: 'desc' }, take: 1 } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      ...(take ? { take } : {}),
    }),
    prisma.lead.findMany({
      where: { AND: [visibleLeads, { businessEmail: { not: null } }, lead] },
      select: { number: true, businessEmail: true, companyName: true, contact: { select: { firstName: true, lastName: true } } },
      orderBy: { id: 'desc' },
      ...(take ? { take } : {}),
    }),
  ]);
  const out = new Map<string, Recipient>();
  for (const c of contacts) {
    const address = c.businessEmail!.trim().toLowerCase();
    if (address && !out.has(address)) out.set(address, { address, name: `${c.firstName} ${c.lastName}`.trim() || null, leadNumber: c.leads[0]?.number ?? null });
  }
  for (const l of leads) {
    const address = l.businessEmail!.trim().toLowerCase();
    if (!address) continue;
    const known = out.get(address);
    if (known) known.leadNumber ??= l.number;
    else out.set(address, { address, name: (l.contact ? `${l.contact.firstName} ${l.contact.lastName}`.trim() : '') || l.companyName, leadNumber: l.number });
  }
  return [...out.values()];
}

/** At most 8 recipients the user can see whose name or address contains `q` (case-insensitive, wildcards literal). */
export async function suggestRecipients(user: AuthUser, q: string): Promise<Recipient[]> {
  const like = { contains: escapeLike(q), mode: 'insensitive' as const };
  const found = await people(
    user,
    { OR: [{ businessEmail: like }, { firstName: like }, { lastName: like }] },
    { OR: [{ businessEmail: like }, { companyName: like }] },
    SUGGESTIONS_MAX,
  );
  return found.slice(0, SUGGESTIONS_MAX);
}

/** Each address (lower-cased, once) named when the user can see a contact or lead with it; `name: null` otherwise. */
export async function resolveRecipients(user: AuthUser, addresses: string[]): Promise<Recipient[]> {
  const wanted = lower(addresses);
  if (!wanted.length) return [];
  const match = { in: wanted, mode: 'insensitive' as const };
  const known = new Map((await people(user, { businessEmail: match }, { businessEmail: match })).map((r) => [r.address, r]));
  return wanted.map((address) => known.get(address) ?? { address, name: null, leadNumber: null });
}
