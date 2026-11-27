import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type GraphFlag } from '../src/graph/client';
import { BULK_CONCURRENCY } from '../src/mail/changes';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 2, Task 5: delete, archive, move, flag and read/unread in the owner's Outlook, single and bulk. */

const g = vi.hoisted(() => ({
  moves: [] as [string, string][],
  flags: [] as [string, unknown][],
  deletes: [] as string[],
  reads: [] as [string, boolean][],
  /** Thrown by the next Graph call (then cleared). */
  fail: null as unknown,
  /** Graph calls running now, and the most at once. */
  running: 0,
  peak: 0,
  delayMs: 0,
}));

async function graphCall(record: () => void) {
  g.running += 1;
  g.peak = Math.max(g.peak, g.running);
  try {
    if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs));
    if (g.fail) {
      const err = g.fail;
      g.fail = null;
      throw err;
    }
    record();
  } finally {
    g.running -= 1;
  }
}

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({
    graph: fakeGraph({
      moveTo: (_a, id, folder) => graphCall(() => g.moves.push([id, folder])),
      setFlag: (_a, id, flag: GraphFlag) => graphCall(() => g.flags.push([id, flag])),
      deleteMessage: (_a, id) => graphCall(() => g.deletes.push(id)),
      markRead: (_a, id, isRead) => graphCall(() => g.reads.push([id, isRead])),
    }),
  });
});
afterAll(() => app.close());
beforeEach(async () => {
  Object.assign(g, { moves: [], flags: [], deletes: [], reads: [], fail: null, running: 0, peak: 0, delayMs: 0 });
  await resetDb();
  await seedLookups();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const personal = (userId: number, address: string, status = 'connected') =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status } });

let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Secret proposal', bodyText: 'Looks good', graphId: `g-${n}`,
      threadId: `conv-${n}`, isRead: false, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

/** Rep Maya with a connected mailbox and a message on her lead; admin Deepak with his own mailbox. */
async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const lead = await makeLead({ companyId: acme.id, assignedToId: rep.id, status: 'New' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
  const m = await msg(rep.id, repBox.id, { leadId: lead.id, companyId: acme.id });
  return { rep, admin, acme, lead, repBox, adminBox, m, repCookie: await signIn(app, rep), adminCookie: await signIn(app, admin) };
}

const row = (id: number) => prisma.emailMessage.findUnique({ where: { id } });

describe('mailbox changes (web-mail release 2)', () => {
  it('move to Archive / Inbox / Deleted items calls Graph on the owner mailbox, then sets the folder', async () => {
    const { m, repCookie } = await setup();
    for (const [folder, graphFolder] of [['archive', 'archive'], ['inbox', 'inbox'], ['deleted', 'deleteditems']] as const) {
      const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'move', folder });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: m.id, folder, isRead: false, flagStatus: 'notFlagged', flagDue: null, removed: false });
      expect(g.moves.at(-1)).toEqual([m.graphId, graphFolder]);
      expect((await row(m.id))!.folder).toBe(folder);
    }
    expect(g.moves).toHaveLength(3);
  });

  it('Delete moves to Deleted items; Delete in Deleted items deletes in Outlook and removes the row', async () => {
    const { m, repCookie } = await setup();
    const first = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'delete' });
    expect(first.json()).toMatchObject({ id: m.id, folder: 'deleted', removed: false });
    expect(g.moves).toEqual([[m.graphId, 'deleteditems']]);
    expect(g.deletes).toEqual([]);
    const second = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'delete' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: m.id, folder: 'deleted', removed: true });
    expect(g.deletes).toEqual([m.graphId]);
    expect(await prisma.emailMessage.findUnique({ where: { id: m.id } })).toBeNull();
    // Gone: a further change is 404.
    expect((await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'delete' })).statusCode).toBe(404);
  });

  it('Flag Tomorrow for an Asia/Kolkata user at 23:30 UTC flags their day after tomorrow (UTC) with their zone', async () => {
    const { rep, m, repCookie } = await setup();
    await prisma.user.update({ where: { id: rep.id }, data: { timezone: 'Asia/Kolkata' } });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-26T23:30:00Z') });
    const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'flag', flag: 'tomorrow' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: m.id, flagStatus: 'flagged', flagDue: '2026-11-28' });
    expect(g.flags.at(-1)).toEqual([m.graphId, { status: 'flagged', start: '2026-11-27', due: '2026-11-28', timeZone: 'Asia/Kolkata' }]);
    const r = await row(m.id);
    expect(r).toMatchObject({ flagStatus: 'flagged' });
    expect(r!.flagDue!.toISOString().slice(0, 10)).toBe('2026-11-28');
  });

  it('Mark complete, Clear flag, No date and read/unread change Outlook and the row', async () => {
    const { m, repCookie } = await setup();
    const change = async (body: unknown) => {
      const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, body);
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    expect(await change({ type: 'flag', flag: 'noDate' })).toMatchObject({ flagStatus: 'flagged', flagDue: null });
    expect(g.flags.at(-1)).toEqual([m.graphId, { status: 'flagged', start: null, due: null, timeZone: 'Europe/London' }]);
    expect(await row(m.id)).toMatchObject({ flagStatus: 'flagged', flagDue: null });
    expect(await change({ type: 'flag', flag: 'complete' })).toMatchObject({ flagStatus: 'complete', flagDue: null });
    expect(g.flags.at(-1)).toEqual([m.graphId, { status: 'complete' }]);
    expect(await row(m.id)).toMatchObject({ flagStatus: 'complete', flagDue: null });
    expect(await change({ type: 'flag', flag: 'clear' })).toMatchObject({ flagStatus: 'notFlagged', flagDue: null });
    expect(g.flags.at(-1)).toEqual([m.graphId, { status: 'notFlagged' }]);
    expect(await row(m.id)).toMatchObject({ flagStatus: 'notFlagged', flagDue: null });
    expect(await change({ type: 'read', isRead: true })).toMatchObject({ isRead: true });
    expect(await row(m.id)).toMatchObject({ isRead: true });
    expect(await change({ type: 'read', isRead: false })).toMatchObject({ isRead: false });
    expect(await row(m.id)).toMatchObject({ isRead: false });
    expect(g.reads).toEqual([[m.graphId, true], [m.graphId, false]]);
  });

  it('Outlook refuses (404) or throttles (429): the row is unchanged and the answer is outlook_refused 502 / outlook_busy 503 (Review Focus 1)', async () => {
    const { m, repCookie } = await setup();
    const before = await row(m.id);
    for (const [err, status, error] of [
      [new GraphError('graph_request_failed status=404', 404), 502, 'outlook_refused'],
      [new GraphError('graph_request_failed status=400', 400), 502, 'outlook_refused'],
      [new GraphError('graph_request_failed status=429', 429), 503, 'outlook_busy'],
      [new GraphError('graph_request_failed status=500', 500), 503, 'outlook_busy'],
      [new GraphError('graph_request_failed timeout', 504), 503, 'outlook_busy'],
      // Not a Graph error (F22): a network failure is treated like throttling, never a 500.
      [new TypeError('fetch failed'), 503, 'outlook_busy'],
    ] as const) {
      g.fail = err;
      const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'move', folder: 'archive' });
      expect([res.statusCode, res.json()]).toEqual([status, { error }]);
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).folder).toBe('inbox');
    }
    // A refused permanent delete keeps the row.
    await prisma.emailMessage.update({ where: { id: m.id }, data: { folder: 'deleted' } });
    g.fail = new GraphError('graph_request_failed status=404', 404);
    expect((await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'delete' })).statusCode).toBe(502);
    expect(await row(m.id)).toMatchObject({ folder: 'deleted', isRead: before!.isRead });
    // /read and /archive answer the same way.
    g.fail = new GraphError('graph_request_failed status=429', 429);
    expect((await call('POST', `/api/mail/${m.id}/read`, repCookie, { isRead: true })).json()).toEqual({ error: 'outlook_busy' });
    expect((await row(m.id))!.isRead).toBe(false);
  });

  it('a revoked mailbox answers mailbox_not_connected and puts the account in error; a disconnected one changes nothing', async () => {
    const { m, repBox, repCookie } = await setup();
    g.fail = new GraphError('graph_request_failed status=401', 401);
    const res = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'move', folder: 'archive' });
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'mailbox_not_connected' }]);
    expect(await prisma.emailAccount.findUniqueOrThrow({ where: { id: repBox.id } })).toMatchObject({ status: 'error' });
    expect((await row(m.id))!.folder).toBe('inbox');
    // Now in error (and later disconnected): Outlook is not asked and nothing changes.
    for (const status of ['error', 'disconnected']) {
      await prisma.emailAccount.update({ where: { id: repBox.id }, data: { status } });
      const again = await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'read', isRead: true });
      expect([again.statusCode, again.json()]).toEqual([409, { error: 'mailbox_not_connected' }]);
    }
    expect(g.reads).toEqual([]);
    expect(await row(m.id)).toMatchObject({ folder: 'inbox', isRead: false });
    // An MSAL revoked consent (not a GraphError) is a revoked mailbox too.
    await prisma.emailAccount.update({ where: { id: repBox.id }, data: { status: 'connected' } });
    g.fail = Object.assign(new Error('invalid_grant: AADSTS70000'), { errorCode: 'invalid_grant' });
    expect((await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'delete' })).json()).toEqual({ error: 'mailbox_not_connected' });
    expect(await prisma.emailAccount.findUniqueOrThrow({ where: { id: repBox.id } })).toMatchObject({ status: 'error' });
  });

  it('a CRM message still sending is 409 sending; a draft cannot be moved (409 draft) but can be deleted', async () => {
    const { rep, repBox, repCookie } = await setup();
    for (const status of ['queued', 'sending']) {
      const s = await msg(rep.id, repBox.id, { folder: 'sent', status, source: 'crm', graphId: null });
      for (const change of [{ type: 'delete' }, { type: 'move', folder: 'archive' }, { type: 'read', isRead: true }, { type: 'flag', flag: 'today' }]) {
        const res = await call('POST', `/api/mail/${s.id}/change`, repCookie, change);
        expect([res.statusCode, res.json()]).toEqual([409, { error: 'sending' }]);
      }
      expect(await row(s.id)).toMatchObject({ folder: 'sent', status });
    }
    const draft = await msg(rep.id, repBox.id, { folder: 'drafts', status: 'draft' });
    for (const folder of ['archive', 'inbox', 'deleted']) {
      const res = await call('POST', `/api/mail/${draft.id}/change`, repCookie, { type: 'move', folder });
      expect([res.statusCode, res.json()]).toEqual([409, { error: 'draft' }]);
    }
    expect((await call('POST', `/api/mail/${draft.id}/archive`, repCookie)).json()).toEqual({ error: 'draft' });
    expect(g.moves).toEqual([]);
    const del = await call('POST', `/api/mail/${draft.id}/change`, repCookie, { type: 'delete' });
    expect(del.json()).toMatchObject({ id: draft.id, folder: 'deleted', removed: false });
    expect(g.moves).toEqual([[draft.graphId, 'deleteditems']]);
  });

  it('a CRM-only failed message (no Graph id) changes in the CRM without calling Graph', async () => {
    const { rep, repBox, repCookie } = await setup();
    const failed = await msg(rep.id, repBox.id, { folder: 'sent', status: 'failed', source: 'crm', graphId: null, isRead: true });
    expect((await call('POST', `/api/mail/${failed.id}/change`, repCookie, { type: 'flag', flag: 'today' })).statusCode).toBe(200);
    expect((await call('POST', `/api/mail/${failed.id}/change`, repCookie, { type: 'delete' })).json()).toMatchObject({ folder: 'deleted', removed: false });
    expect((await call('POST', `/api/mail/${failed.id}/change`, repCookie, { type: 'delete' })).json()).toMatchObject({ removed: true });
    expect(await row(failed.id)).toBeNull();
    // Even with the mailbox disconnected: nothing to ask Outlook.
    await prisma.emailAccount.update({ where: { id: repBox.id }, data: { status: 'disconnected' } });
    const other = await msg(rep.id, repBox.id, { folder: 'sent', status: 'failed', source: 'crm', graphId: null });
    expect((await call('POST', `/api/mail/${other.id}/change`, repCookie, { type: 'move', folder: 'archive' })).json()).toMatchObject({ folder: 'archive' });
    expect([g.moves, g.flags, g.deletes, g.reads]).toEqual([[], [], [], []]);
  });

  it("another user's message: change is 403 view_only and Graph is not called", async () => {
    const { m, adminCookie } = await setup();
    const before = await row(m.id);
    for (const change of [{ type: 'delete' }, { type: 'move', folder: 'archive' }, { type: 'read', isRead: true }, { type: 'flag', flag: 'today' }]) {
      const res = await call('POST', `/api/mail/${m.id}/change`, adminCookie, change);
      expect([res.statusCode, res.json()]).toEqual([403, { error: 'view_only' }]);
    }
    expect([g.moves, g.flags, g.deletes, g.reads]).toEqual([[], [], [], []]);
    expect(await row(m.id)).toEqual(before);
    // A Sales rep reaching another user's message gets 404 (cannot tell it exists).
    const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
    expect((await call('POST', `/api/mail/${m.id}/change`, await signIn(app, carlos), { type: 'delete' })).statusCode).toBe(404);
  });

  it("bulk: own messages change, another user's are failed view_only, unknown ids not_found; at most 50 ids", async () => {
    const { rep, admin, repBox, adminBox, m: other, adminCookie, repCookie } = await setup();
    const a = await msg(admin.id, adminBox.id);
    const b = await msg(admin.id, adminBox.id);
    const res = await call('POST', '/api/mail/bulk', adminCookie, { ids: [a.id, other.id, b.id, 999999], change: { type: 'move', folder: 'archive' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      done: [expect.objectContaining({ id: a.id, folder: 'archive' }), expect.objectContaining({ id: b.id, folder: 'archive' })],
      failed: [{ id: other.id, error: 'view_only' }, { id: 999999, error: 'not_found' }],
    });
    expect(g.moves).toEqual([[a.graphId, 'archive'], [b.graphId, 'archive']]);
    expect((await row(other.id))!.folder).toBe('inbox');
    expect((await call('POST', '/api/mail/bulk', repCookie, { ids: Array.from({ length: 51 }, (_, i) => i + 1), change: { type: 'delete' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/mail/bulk', repCookie, { ids: [], change: { type: 'delete' } })).statusCode).toBe(400);
    // A refusal fails that id only, with its reason; a still-sending message too.
    const c = await msg(rep.id, repBox.id);
    const d = await msg(rep.id, repBox.id);
    const sending = await msg(rep.id, repBox.id, { folder: 'sent', status: 'sending', source: 'crm', graphId: null });
    g.fail = new GraphError('graph_request_failed status=429', 429);
    const partly = await call('POST', '/api/mail/bulk', repCookie, { ids: [c.id, sending.id], change: { type: 'read', isRead: true } });
    expect(partly.json()).toEqual({ done: [], failed: [{ id: c.id, error: 'outlook_busy' }, { id: sending.id, error: 'sending' }] });
    expect((await row(c.id))!.isRead).toBe(false);
    const ok = await call('POST', '/api/mail/bulk', repCookie, { ids: [c.id, d.id, c.id], change: { type: 'read', isRead: true } });
    expect(ok.json().done.map((x: { id: number }) => x.id)).toEqual([c.id, d.id]);
  });

  it('bulk is limited per user: 30 a minute, the 31st is 429 (as sending)', async () => {
    // Its own app: the limiter's counts live in the app, and user ids repeat after each test's database reset.
    const fresh = await buildApp({ graph: fakeGraph({ markRead: async () => undefined }) });
    try {
      const cookie = await signIn(fresh, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
      const codes: number[] = [];
      for (let i = 0; i < 31; i++) {
        codes.push((await fresh.inject({ method: 'POST', url: '/api/mail/bulk', headers: { cookie }, payload: { ids: [999999], change: { type: 'read', isRead: true } } })).statusCode);
      }
      expect(codes.slice(0, 30)).toEqual(Array(30).fill(200));
      expect(codes[30]).toBe(429);
    } finally {
      await fresh.close();
    }
  });

  it(`bulk runs at most ${BULK_CONCURRENCY} Graph calls at once, and a conversation's 50 messages all change`, async () => {
    const { rep, repBox, repCookie } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 50; i += 1) ids.push((await msg(rep.id, repBox.id, { threadId: 'conv-big' })).id);
    g.delayMs = 5;
    const res = await call('POST', '/api/mail/bulk', repCookie, { ids, change: { type: 'delete' } });
    expect(res.json().done).toHaveLength(50);
    expect(res.json().failed).toEqual([]);
    expect(g.peak).toBe(BULK_CONCURRENCY);
    expect(await prisma.emailMessage.count({ where: { threadId: 'conv-big', folder: 'deleted' } })).toBe(50);
  });

  it('nothing about the mail is logged: no subject or address in the app log on a refusal', async () => {
    const { m, repCookie } = await setup();
    const lines: unknown[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(app.log, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    g.fail = new GraphError('graph_request_failed status=404 Secret proposal ana@acme.com', 404);
    expect((await call('POST', `/api/mail/${m.id}/change`, repCookie, { type: 'move', folder: 'archive' })).statusCode).toBe(502);
    g.fail = new TypeError('fetch failed for ana@acme.com');
    expect((await call('POST', '/api/mail/bulk', repCookie, { ids: [m.id], change: { type: 'delete' } })).statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(lines);
    expect(text).toContain('outlook_refused');
    expect(text).not.toMatch(/Secret proposal|ana@acme\.com|maya@daitpartners\.com/i);
  });
});

