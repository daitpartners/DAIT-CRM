import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { QuotationCreate, QuotationDecision, QuotationListQuery, QuotationSend, QuotationUpdate, type QuoteTab } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser, type AuthUser } from '../plugins/auth.js';
import { StaleError, isNotFound } from '../prismaErrors.js';
import { RuleError } from '../leads/service.js';
import { todayIn } from '../leads/dates.js';
import { quotationWhere } from '../quotations/visibility.js';
import { renderQuotationPdf } from '../quotations/pdf.js';
import { pdfLang, queueQuotationSend } from '../quotations/send.js';
import {
  createQuotation, decideQuotation, duplicateQuotation, loadCompanySettings, markNegotiating, quotationDetail, quotationInclude,
  quotationListInclude, quotationListItem, quotationSnapshot, sumsByCurrency, updateQuotation, type QuotationSnapshot,
} from '../quotations/service.js';

/** RuleError codes answered with 409; `forbidden` is a 403; any other rule refusal is a 400. */
const CONFLICT_CODES = new Set(['locked', 'sending', 'unsent_changes', 'invalid_transition', 'no_contact_email', 'no_mailbox', 'pdf_too_large', 'total_too_large']);

async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StaleError || isNotFound(e)) return reply.code(409).send({ error: 'stale' });
    if (e instanceof RuleError) {
      const code = e.code === 'forbidden' ? 403 : CONFLICT_CODES.has(e.code) ? 409 : 400;
      return reply.code(code).send({ error: e.code });
    }
    throw e;
  }
}

/** Prototype V.quotes tab filters. */
const TABS: Record<QuoteTab, (status: string) => boolean> = {
  all: () => true,
  draft: (s) => s === 'Draft',
  sent: (s) => s === 'Sent' || s === 'Negotiating',
  accepted: (s) => s === 'Accepted',
  closed: (s) => s === 'Rejected' || s === 'Expired',
};

async function detailOf(id: number, user: AuthUser) {
  const q = await prisma.quotation.findFirst({ where: { AND: [{ id }, quotationWhere(user)] }, include: quotationInclude });
  if (!q) throw new NotFoundError();
  // The GST each currency starts with (Company details), so the editor shows it at once on a currency change.
  const settings = await loadCompanySettings(prisma);
  return { ...quotationDetail(q, user), taxDefaults: { INR: settings.taxInr, USD: settings.taxUsd, CAD: settings.taxCad } };
}

const idOf = (raw: string) => Number(raw);

export const quotationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Every visible quotation (newest date first) for the tab and search, with the tab counts and tiles computed over
   * all visible quotations, as the prototype does. Totals are the display figures (last sent revision while revision
   * n+1 is unsent).
   */
  app.get('/quotations', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(QuotationListQuery, request.query);
    const user = request.user!;
    const today = todayIn(user.timezone);
    const rows = await prisma.quotation.findMany({
      where: query.companyId ? { AND: [quotationWhere(user), { companyId: query.companyId }] } : quotationWhere(user), include: quotationListInclude, orderBy: [{ quotationDate: 'desc' }, { id: 'desc' }],
    });
    const all = rows.map((r) => quotationListItem(r, today));
    const s = query.s?.toLowerCase();
    const items = all.filter((q) => TABS[query.tab](q.status)
      && (!s || [q.number, q.company.name, q.company.legalName ?? '', q.lead?.number ?? '', q.subject].join(' ').toLowerCase().includes(s)));
    const open = all.filter((q) => TABS.sent(q.status));
    const accepted = all.filter((q) => TABS.accepted(q.status));
    const sentCount = all.filter((q) => q.status !== 'Draft').length;
    return {
      items,
      counts: {
        all: all.length, draft: all.filter((q) => TABS.draft(q.status)).length, sent: open.length, accepted: accepted.length,
        closed: all.filter((q) => TABS.closed(q.status)).length,
      },
      tiles: {
        openCount: open.length,
        openSums: sumsByCurrency(open),
        acceptedCount: accepted.length,
        acceptedSums: sumsByCurrency(accepted),
        expiringSoon: open.filter((q) => q.expiringSoon).map((q) => ({ id: q.id, number: q.number, validUntil: q.validUntil })),
        winRate: Math.round((accepted.length / Math.max(1, sentCount)) * 100),
        sentCount,
      },
    };
  });

  app.post('/quotations', { preHandler: [requireRight('manage_quotes')] }, async (request, reply) => {
    const body = parseBody(QuotationCreate, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const id = await prisma.$transaction((tx) => createQuotation(tx, user, body));
      return reply.code(201).send(await detailOf(id, user));
    });
  });

  app.get<{ Params: { id: string } }>('/quotations/:id', { preHandler: [requireUser] }, async (request) => {
    const id = idOf(request.params.id);
    if (!Number.isInteger(id)) throw new NotFoundError();
    return detailOf(id, request.user!);
  });

  /**
   * The quotation as a PDF, in its owner's language: the working copy (Draft, or revision n+1 being edited), or sent
   * revision `rev` drawn from its frozen snapshot. 404 when the quotation is hidden or the revision does not exist.
   */
  app.get<{ Params: { id: string }; Querystring: { rev?: string } }>('/quotations/:id/pdf', { preHandler: [requireUser] }, async (request, reply) => {
    const id = idOf(request.params.id);
    const rawRev = request.query.rev;
    const rev = rawRev === undefined ? null : Number(rawRev);
    if (!Number.isInteger(id) || (rev !== null && !Number.isInteger(rev))) throw new NotFoundError();
    const q = await prisma.quotation.findFirst({
      where: { AND: [{ id }, quotationWhere(request.user!)] },
      select: { id: true, owner: { select: { language: true } } },
    });
    if (!q) throw new NotFoundError();
    let snap: QuotationSnapshot;
    if (rev === null) {
      snap = await quotationSnapshot(prisma, q.id);
    } else {
      const r = await prisma.quotationRevision.findUnique({ where: { quotationId_revisionNo: { quotationId: q.id, revisionNo: rev } } });
      if (!r) throw new NotFoundError();
      snap = r.snapshot as unknown as QuotationSnapshot;
    }
    // A sent revision prints the issuer frozen in its snapshot; the working copy the current Company details.
    const pdf = await renderQuotationPdf(snap, await loadCompanySettings(prisma), pdfLang(q.owner.language));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${snap.number}-rev${rev ?? snap.revision}.pdf"`)
      .send(pdf);
  });

  app.patch<{ Params: { id: string } }>('/quotations/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const body = parseBody(QuotationUpdate, request.body);
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction((tx) => updateQuotation(tx, user, id, body));
      return detailOf(id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/quotations/:id/negotiate', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction((tx) => markNegotiating(tx, user, id));
      return detailOf(id, user);
    });
  });

  for (const [path, to] of [['accept', 'Accepted'], ['reject', 'Rejected']] as const) {
    app.post<{ Params: { id: string } }>(`/quotations/:id/${path}`, { preHandler: [requireUser] }, async (request, reply) => {
      const body = parseBody(QuotationDecision, request.body);
      const user = request.user!;
      const id = idOf(request.params.id);
      return guard(reply, async () => {
        await prisma.$transaction((tx) => decideQuotation(tx, user, id, to, body.discardUnsent === true));
        return detailOf(id, user);
      });
    });
  }

  /**
   * Send by email: queues the PDF of the revision being worked on to the quotation's contact from the user's own
   * mailbox (202 with `sending: true`). The revision, status and lead change only when the send job succeeds. 409
   * `stale` when the quotation changed after the dialog was opened (`updatedAt`).
   */
  app.post<{ Params: { id: string } }>('/quotations/:id/send', { preHandler: [requireRight('use_email')] }, async (request, reply) => {
    const body = parseBody(QuotationSend, request.body ?? {});
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction((tx) => queueQuotationSend(tx, user, id, body.body, body.updatedAt));
      return reply.code(202).send(await detailOf(id, user));
    });
  });

  app.post<{ Params: { id: string } }>('/quotations/:id/duplicate', { preHandler: [requireRight('manage_quotes')] }, async (request, reply) => {
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      const newId = await prisma.$transaction((tx) => duplicateQuotation(tx, user, id));
      return reply.code(201).send(await detailOf(newId, user));
    });
  });
};
