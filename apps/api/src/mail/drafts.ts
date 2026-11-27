import type { EmailAccount, EmailMessage, Prisma } from '@prisma/client';
import { localNow, replyRecipients, replySubject, resolveTimezones, type DraftCreate, type DraftSave } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { GraphError, type DraftFields, type GraphClient } from '../graph/client.js';
import type { AuthUser } from '../plugins/auth.js';
import { companyWhere } from '../companies/visibility.js';
import { assertLeadVisible, canSeeLead, leadWhere } from '../leads/visibility.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { MailAccessError, canSeeTeamMail, messageFor } from './access.js';
import { processEmailBody } from './bodies.js';
import { MailChangeError, outlookFailure } from './changes.js';
import { cidsOf, detachRemovedPictures, fileOfGraph, fileViews, filesData, filesOf, type DraftFile, type DraftFileView } from './draftFiles.js';
import { outgoingBody } from './formatted.js';
import { textToHtml } from './html.js';
import { leadPanel, type LeadPanel } from './leadPanel.js';
import { participantsOf } from './leadMail.js';
import { assertProjectFor } from './outgoing.js';

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
    readonly code:
      | 'no_mailbox' | 'draft_gone' | 'not_draft' | 'no_recipients' | 'schedule_time' | 'follow_up_time' | 'already_sent' | 'mailbox_changed',
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

export type { DraftFile, DraftFileView } from './draftFiles.js';

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
export async function onDraft<T>(account: EmailAccount, call: () => Promise<T>): Promise<T> {
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

const draftLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` alone for draft `id` (web-mail release 3, Task 6 review Minor 3): every route that changes a draft or its
 * Outlook copy (save, files, template, discard, send, undo, send now) waits for the one before it on the same draft,
 * so a save can never PATCH Outlook after Send queued the draft (it then reads the queued row and answers 409
 * not_draft), and Send never queues while a save is in flight. In-process: the API runs as one process (PM2 fork
 * mode, deploy/ecosystem.config.cjs); the guarded row updates (status draft/failed) stay as the database's own check.
 */
export async function withDraftLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = draftLocks.get(id) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  draftLocks.set(id, settled);
  try {
    return await run;
  } finally {
    if (draftLocks.get(id) === settled) draftLocks.delete(id);
  }
}

/** The draft's own mailbox, which must be the caller's connected one now: a draft of a mailbox since replaced is 409 mailbox_changed. */
export async function draftAccount(user: AuthUser, m: EmailMessage): Promise<EmailAccount> {
  const account = await myAccount(user.id);
  if (m.accountId !== account.id) throw new DraftError('mailbox_changed', 409);
  return account;
}

/** A draft the editor may open or save (folder drafts, status draft or failed), else 409 not_draft. */
export function assertEditable(m: EmailMessage): void {
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
    return dropIfUnsaved(graph, account, d.id, () => prisma.emailMessage.create({
      data: {
        ...rowOf(user, account, d.id, d.conversationId, fields, userPart, null),
        leadId: lead?.id ?? null, companyId: lead?.companyId ?? null, contactId: lead?.contactId ?? null, projectId: body.projectId ?? null,
      },
    }));
  }

  const { m: original } = await messageFor(prisma, user, String(body.replyToId), 'change');
  if (original.status === 'draft' || original.folder === 'drafts') throw new MailChangeError('draft', 409);
  const account = await myAccount(user.id);
  const own = lower([account.address, ...(account.sendAs ? [account.sendAs] : [])]);
  const { to } = replyRecipients({ ...original, toAddresses: original.toAddresses as string[] }, body.kind, own, []);
  const cc = body.kind === 'replyAll' ? lower(original.ccAddresses as string[]).filter((a) => !own.includes(a)) : [];
  const subject = replySubject(original.subject, body.kind);

  const leadId = original.leadId !== null && (await canSeeLead(prisma, user, original.leadId)) ? original.leadId : null;
  const insert = (draftId: string, conversationId: string | null, fields: DraftFields, quotedHtml: string, files: DraftFile[]) =>
    prisma.emailMessage.create({
      data: {
        ...rowOf(user, account, draftId, conversationId, fields, userPart, quotedHtml),
        ...filesData(files),
        replyToId: original.id, leadId, companyId: original.companyId, contactId: original.contactId, projectId: original.projectId,
      },
    });

  if (original.graphId && original.accountId === account.id) {
    const graphId = original.graphId;
    const d = await inOutlook(account, () => graph.createReplyDraft(account, graphId, body.kind as 'reply' | 'replyAll' | 'forward'));
    return dropIfUnsaved(graph, account, d.id, async () => {
      // The files Outlook put on the draft (a forward's attachments, the quote's pictures), so their cid: pictures stay.
      const files = (await onDraft(account, () => graph.getDraft(account, d.id))).attachments.map((a) => fileOfGraph(a));
      const quotedHtml = (await sanitisedWhole(d.html, QUOTE_MAX, cidsOf(files))).html;
      const fields: DraftFields = { subject, html: userPart + quotedHtml, to, cc, bcc: [], from: account.sendAs };
      // Outlook holds exactly what the CRM shows: the shared recipients and subject, the user part and the sanitised quote.
      await onDraft(account, () => graph.updateDraft(account, d.id, fields));
      return insert(d.id, d.conversationId ?? original.threadId, fields, quotedHtml, files);
    });
  }
  const stored = original.bodyHtml || textToHtml(original.bodyText);
  const header = textToHtml(quoteHeader(original, user.timezone));
  const quotedHtml = (await sanitisedWhole(`<hr><div id="divRplyFwdMsg">${header}</div><br>${stored}`, QUOTE_MAX)).html;
  const fields: DraftFields = { subject, html: userPart + quotedHtml, to, cc, bcc: [], from: account.sendAs };
  const d = await inOutlook(account, () => graph.createDraft(account, fields));
  return dropIfUnsaved(graph, account, d.id, () => insert(d.id, original.threadId, fields, quotedHtml, []));
}

/**
 * Runs the steps after a new Outlook draft was made (reading its files, writing it, its CRM row); when one fails, the
 * Outlook draft is deleted (best effort, so no orphan is left in the user's Drafts) and the failure rethrown.
 */
async function dropIfUnsaved<T>(graph: GraphClient, account: EmailAccount, draftId: string, steps: () => Promise<T>): Promise<T> {
  try {
    return await steps();
  } catch (err) {
    await graph.deleteMessage(account, draftId).catch(() => undefined);
    throw err;
  }
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
 * change. Gone in Outlook → draft_gone, and the row is left as it was. A draft of a mailbox since replaced (reconnected
 * as another account) is 409 mailbox_changed: it is never written, or sent, through the new one.
 */
export async function saveDraft(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftSave): Promise<{ savedAt: string }> {
  assertEditable(m);
  const account = await draftAccount(user, m);
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
