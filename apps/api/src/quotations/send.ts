import type { EmailMessage, Prisma } from '@prisma/client';
import { defaultQuotationEmailBody, formatMoney, isClosedStatus, isQuoteLocked, type Lang } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from '../audit.js';
import { RuleError, applyStatusChange } from '../leads/service.js';
import { notifyUser } from '../leads/notify.js';
import { queueOutgoing } from '../mail/outgoing.js';
import { renderQuotationPdf } from './pdf.js';
import { appendHistory, editableQuotation, exceedsAmountCap, loadCompanySettings, quotationSnapshot, type QuotationSnapshot } from './service.js';

/*
 * Send by email (release 3A). The PDF is drawn from a snapshot when the send is queued and travels on the send job,
 * so the client receives exactly what was previewed. Nothing on the quotation or lead changes until Microsoft
 * confirms the send (onQuotationSent); a send that finally fails only leaves a history line and tells the owner
 * (onQuotationSendFailed). The email itself stays the sender's private mail, linked to the lead (2B-1).
 */

type Tx = Prisma.TransactionClient;

const PDF_LANGS = new Set<string>(['en', 'es', 'fr']);
/**
 * Graph takes inline attachments in a request of at most 4 MB: the PDF's base64 (a third larger than the file, so a
 * PDF of about 2.8 MB) must leave room for the rest of the message (body up to 20,000 characters, headers).
 */
export const MAX_PDF_BASE64 = 3_750_000;
/** The lead status a sent quotation moves an earlier lead to (prototype sendQuote). */
const PROPOSAL_SENT = 'Proposal Sent';

/** The PDF language: the quotation owner's (en / es / fr), as on Preview and Download. */
export const pdfLang = (language: string | null | undefined): Lang => (PDF_LANGS.has(language ?? '') ? (language as Lang) : 'en');

/**
 * Queues quotation `id` for sending to its contact from the user's own mailbox, with the PDF of the revision being
 * worked on attached and the issuer frozen into the snapshot. 409 `no_contact_email` without a contact address,
 * `no_mailbox` without the user's connected mailbox (and the editableQuotation refusals: `locked`, `sending`, …;
 * `stale` when `updatedAt`, the version the send dialog was opened on, has moved on). While queued the quotation
 * shows "Sending…" (sendingMessageId) and cannot be edited or sent again.
 */
export async function queueQuotationSend(tx: Tx, user: AuthUser, id: number, body?: string, updatedAt?: string): Promise<void> {
  const q = await editableQuotation(tx, user, id, updatedAt);
  const to = q.contact?.businessEmail?.trim().toLowerCase();
  if (!to) throw new RuleError('no_contact_email');
  const account = await tx.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
  if (!account) throw new RuleError('no_mailbox');

  const settings = await loadCompanySettings(tx);
  // Sending again with no edits re-sends revision n exactly as it was first sent (its frozen snapshot), so the client
  // never holds two different "rev n" PDFs; otherwise the working copy, with the issuer frozen now.
  const sentRow = q.editingNewRevision ? null : q.revisions.find((r) => r.revisionNo === q.revision);
  const snapshot: QuotationSnapshot = sentRow
    ? (sentRow.snapshot as unknown as QuotationSnapshot)
    : {
      ...(await quotationSnapshot(tx, q.id)),
      issuer: { legalName: settings.legalName, addressLines: settings.addressLines, email: settings.email, gstin: settings.gstin },
    };
  // The revision row's figures go into Decimal(14,2) columns when the send succeeds: refuse now, before the email
  // leaves, rather than fail to record it afterwards (saves are capped the same way; this catches older rows).
  if (exceedsAmountCap(snapshot.totals)) throw new RuleError('total_too_large');
  const owner = await tx.user.findUniqueOrThrow({ where: { id: q.ownerId }, select: { language: true } });
  const lang = pdfLang(owner.language);
  const pdf = (await renderQuotationPdf(snapshot, settings, lang)).toString('base64');
  if (pdf.length > MAX_PDF_BASE64) throw new RuleError('pdf_too_large');

  const lead = q.leadId === null ? null : await tx.lead.findUnique({ where: { id: q.leadId } });
  const msg = await queueOutgoing(tx, user, account, {
    lead, companyId: q.companyId, contactId: q.contactId, to: [to], cc: [],
    subject: `Quotation ${snapshot.number} · ${snapshot.subject}`.slice(0, 500),
    body: body?.trim() || defaultQuotationEmailBody(snapshot, lang),
    attachments: [{ name: `${snapshot.number}-rev${snapshot.revision}.pdf`, contentType: 'application/pdf', contentBase64: pdf }],
    quotation: { id: q.id, snapshot },
  });
  await tx.quotation.update({ where: { id: q.id }, data: { sendingMessageId: msg.id } });
  // The message id only: the mail is private to its sender.
  await audit(tx, { entityType: 'quotation', entityId: q.id, action: 'update', userId: user.id, after: { sendingMessageId: msg.id } });
}

/** True when lead status `status` comes before Proposal Sent in the pipeline (the lead_status lookup order). */
async function beforeProposalSent(tx: Tx, status: string): Promise<boolean> {
  if (isClosedStatus(status)) return false;
  const rows = await tx.lookupValue.findMany({ where: { group: 'lead_status', value: { in: [status, PROPOSAL_SENT] } } });
  const current = rows.find((r) => r.value === status);
  const target = rows.find((r) => r.value === PROPOSAL_SENT);
  return !!current && !!target && target.isActive && current.sortOrder < target.sortOrder;
}

/** The quotation whose send is message `messageId`, locked FOR UPDATE; null when none (already settled). */
async function lockSending(tx: Tx, messageId: number) {
  const found = await tx.quotation.findFirst({ where: { sendingMessageId: messageId }, select: { id: true } });
  if (!found) return null;
  await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${found.id} FOR UPDATE`;
  const q = await tx.quotation.findUniqueOrThrow({ where: { id: found.id }, include: { revisions: { select: { revisionNo: true } } } });
  return q.sendingMessageId === messageId ? q : null;
}

/**
 * The send job delivered message `msg` (called in the job's transaction). A revision not sent before (a Draft, or
 * revision n+1 after edits) is frozen from the queued `snapshot`; re-sending the same revision adds a history line
 * only, so (quotation, revision no) stays unique. Status Sent (Negotiating stays); the lead moves to Proposal Sent
 * when it is earlier in the pipeline; the lead timeline gets "Quotation sent · <number> rev <n>" with the total —
 * the only line for this send (no separate "Email sent").
 */
export async function onQuotationSent(
  tx: Tx, msg: Pick<EmailMessage, 'id' | 'userId' | 'toAddresses'>, snapshot: QuotationSnapshot,
): Promise<void> {
  const q = await lockSending(tx, msg.id);
  if (!q) return;
  const n = snapshot.revision;
  const sentTo = (msg.toAddresses as string[])[0] ?? '';
  const fresh = !q.revisions.some((r) => r.revisionNo === n);
  if (fresh) {
    const t = snapshot.totals;
    await tx.quotationRevision.create({
      data: {
        quotationId: q.id, revisionNo: n, sentAt: new Date(), sentTo, subtotal: t.sub, discountTotal: t.disc + t.overall, taxTotal: t.tax,
        grandTotal: t.total, note: 'Sent by email as PDF', snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
  }
  // Nothing locks a quotation while it is sending (edits, accept / reject and expiry all wait); kept as a safeguard.
  const locked = isQuoteLocked(q.status);
  const status = locked || q.status === 'Negotiating' ? q.status : 'Sent';
  const name = snapshot.contact?.name || sentTo;
  // A re-send records its address in the history line (the revision row holds the first send's).
  const history = fresh
    ? `Sent · rev ${n} · emailed as PDF to ${name}`
    : `Sent again · rev ${n} · emailed as PDF to ${name === sentTo ? sentTo : `${name} (${sentTo})`}`;
  await tx.quotation.update({
    where: { id: q.id },
    data: { status, revision: n, editingNewRevision: false, sendingMessageId: null, history: appendHistory(q, history) },
  });

  if (q.leadId !== null) {
    // Lock order everywhere: quotation, then lead.
    await tx.$queryRaw`SELECT id FROM leads WHERE id = ${q.leadId} FOR UPDATE`;
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: q.leadId } });
    await tx.leadActivity.create({
      data: {
        leadId: lead.id, activityType: 'quote', title: `Quotation sent · ${q.number} rev ${n}`, body: formatMoney(snapshot.totals.total, snapshot.currency),
        relatedType: 'quotation', relatedId: q.id, byUserId: msg.userId,
      },
    });
    if (!locked && (await beforeProposalSent(tx, lead.status))) {
      // No source text: the "Quotation sent" line just above already says why (one line, not two alike).
      await applyStatusChange(tx, lead, PROPOSAL_SENT, { userId: msg.userId });
      await audit(tx, { entityType: 'lead', entityId: lead.id, action: 'update', userId: msg.userId, before: { status: lead.status }, after: { status: PROPOSAL_SENT } });
    }
  }
  await audit(tx, {
    entityType: 'quotation', entityId: q.id, action: 'update', userId: msg.userId,
    before: { status: q.status, sendingMessageId: msg.id }, after: { status, revision: n, sendingMessageId: null, emailMessageId: msg.id },
  });
}

/** Why a quotation left "Sending…" without its send effects. */
export type SendOutcome = 'failed' | 'may_have_sent' | 'not_recorded';

/** Send-failure notifications (stored as text, so written in each recipient's language). */
const NOTICES: Record<Lang, Record<SendOutcome, [string, string]>> = {
  en: {
    failed: ['Quotation not sent · {number}', 'The email could not be sent. Send it again from the quotation.'],
    may_have_sent: ['Quotation may not have been sent · {number}', 'Check Sent Items in Outlook before sending again.'],
    not_recorded: [
      'Quotation emailed but not recorded · {number}',
      'The email was sent, but the quotation and lead could not be updated. Check them before sending again.',
    ],
  },
  es: {
    failed: ['Presupuesto no enviado · {number}', 'No se pudo enviar el correo. Vuelve a enviarlo desde el presupuesto.'],
    may_have_sent: ['Puede que el presupuesto no se haya enviado · {number}', 'Revisa Elementos enviados en Outlook antes de volver a enviarlo.'],
    not_recorded: [
      'Presupuesto enviado pero no registrado · {number}',
      'El correo se envió, pero no se pudieron actualizar el presupuesto ni el lead. Revísalos antes de volver a enviarlo.',
    ],
  },
  fr: {
    failed: ['Devis non envoyé · {number}', "L'e-mail n'a pas pu être envoyé. Renvoyez-le depuis le devis."],
    may_have_sent: ["Le devis n'a peut-être pas été envoyé · {number}", 'Vérifiez les Éléments envoyés dans Outlook avant de le renvoyer.'],
    not_recorded: [
      'Devis envoyé mais non enregistré · {number}',
      "L'e-mail a été envoyé, mais le devis et le lead n'ont pas pu être mis à jour. Vérifiez-les avant de le renvoyer.",
    ],
  },
};

const HISTORY: Record<SendOutcome, string> = {
  failed: 'Send failed',
  may_have_sent: 'Send failed · may not have been sent — check Sent Items before sending again',
  not_recorded: 'Emailed, but the send could not be recorded — check the status and lead before sending again',
};

/**
 * The quotation sending message `messageId` leaves "Sending…" without the send effects (status, revision and lead
 * untouched, so it can be sent again): a history line and a notice to its owner and to the user who sent it (one
 * notice when they are the same person), each in that person's language. `failed` — the send job gave up
 * (called in the transaction that marks the message failed); `may_have_sent` — a send interrupted mid-way;
 * `not_recorded` — Microsoft took the email but onQuotationSent kept failing on the job's last attempt.
 */
export async function onQuotationSendFailed(tx: Tx, messageId: number, outcome: SendOutcome = 'failed'): Promise<void> {
  const q = await lockSending(tx, messageId);
  if (!q) return;
  await tx.quotation.update({ where: { id: q.id }, data: { sendingMessageId: null, history: appendHistory(q, HISTORY[outcome]) } });
  const sender = await tx.emailMessage.findUnique({ where: { id: messageId }, select: { userId: true } });
  for (const userId of new Set([q.ownerId, ...(sender ? [sender.userId] : [])])) {
    const who = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { language: true } });
    const [text, detail] = NOTICES[pdfLang(who.language)][outcome];
    await notifyUser(tx, userId, text.replace('{number}', q.number), detail, `/quotations/${q.id}`);
  }
  await audit(tx, {
    entityType: 'quotation', entityId: q.id, action: 'update', userId: null,
    before: { sendingMessageId: messageId }, after: { sendingMessageId: null, outcome },
  });
}
