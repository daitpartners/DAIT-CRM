import type { DraftView } from '../src/api/drafts';

/** A reply draft as the API answers it (POST /api/mail/drafts, GET /api/mail/drafts/:id). */
export function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 50, replyToId: 1, from: 'arjun@daitpartners.com',
    to: [{ address: 'maria@acme.com', name: 'Maria Gómez', leadNumber: 'LD-1178' }],
    cc: [], bcc: [], subject: 'Re: Proposal',
    bodyHtml: '<p><br></p><div class="dait-sig"><b>Arjun Mehta</b></div>',
    quotedHtml: '<p><b>From:</b> Maria Gómez</p><p>Dear Arjun, thank you…</p>',
    files: [], leadId: 5, projectId: null, lead: null, recipientZone: null,
    savedAt: '2026-11-22T14:32:00.000Z', status: 'draft', scheduledAt: null, lastError: null,
    ...over,
  };
}

/**
 * The drafts API for screen tests: POST /api/mail/drafts makes draft 50, 51… (`made` answers each start), the draft is
 * read back, saved, discarded; the signature and templates are served. Answers null for any other request.
 */
export function draftApi(opts: { made?: (n: number, body: Record<string, unknown>) => DraftView; drafts?: Record<number, DraftView> } = {}) {
  const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];
  const drafts: Record<number, DraftView> = { ...(opts.drafts ?? {}) };
  let next = 50;
  const handle = (url: string, init?: RequestInit): Response | null => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (url === '/api/mail/drafts' && method === 'POST') {
      calls.push({ url, method, body });
      const n = next++;
      const v = opts.made?.(n, body ?? {}) ?? draftView({ id: n, replyToId: (body?.replyToId as number | undefined) ?? null });
      drafts[v.id] = v;
      return Response.json(v, { status: 201 });
    }
    const d = /^\/api\/mail\/drafts\/(\d+)$/.exec(url);
    if (d) {
      calls.push({ url, method, body });
      if (method === 'GET') return drafts[Number(d[1])] ? Response.json(drafts[Number(d[1])]) : Response.json({ error: 'not_found' }, { status: 404 });
      if (method === 'PATCH') return Response.json({ savedAt: '2026-11-22T14:40:00.000Z' });
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/mail/drafts/')) {
      calls.push({ url, method, body });
      return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({});
    }
    if (url === '/api/mail/recipients/resolve') return Response.json({ items: [] });
    if (url.startsWith('/api/mail/recipients?')) return Response.json({ items: [] });
    if (url === '/api/me/signature') return Response.json({ html: '<b>Arjun Mehta</b>', auto: true });
    return null;
  };
  const of = (url: string, method?: string) => calls.filter((c) => c.url === url && (!method || c.method === method));
  return { handle, calls, of, drafts };
}
