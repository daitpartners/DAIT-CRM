import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type GraphMessage, type SearchPage } from '../src/graph/client';
import { mailBackfillHandler } from '../src/jobs/handlers/mailBackfill';
import { enqueue, STALE_AFTER_MS } from '../src/jobs/queue';
import {
  BACKFILL_PAGES, backfillStatus, ensureBackfillJob, queueMailboxBackfills, queueNewAddressBackfills, resetFolderCacheForTests,
  retryBackfills, sweepMailBackfill,
} from '../src/mail/backfill';
import { fakeGraph, resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

let boxes = 0;
let acme: { companyId: number; leadId: number; contactId: number };

beforeEach(async () => {
  await resetDb();
  resetFolderCacheForTests();
  boxes = 0;
  const company = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, businessEmail: ' Bob@Acme.com ' });
  acme = { companyId: company.id, leadId: lead.id, contactId: contact.id };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mailbox(over: { status?: string; syncMail?: boolean; isActive?: boolean } = {}) {
  const user = await makeUser({ role: 'SALES_REPRESENTATIVE', isActive: over.isActive ?? true });
  boxes += 1;
  const account = await prisma.emailAccount.create({
    data: {
      userId: user.id, address: `box${boxes}@daitpartners.com`, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'),
      status: over.status ?? 'connected', syncMail: over.syncMail ?? true, syncState: {},
    },
  });
  return { user, account };
}

let n = 0;
function msg(over: Partial<GraphMessage> = {}): GraphMessage {
  n += 1;
  return {
    id: `g${n}`, subject: 'Hello', from: { name: 'Ana Ruiz', address: 'ana@acme.com' }, to: ['box1@daitpartners.com'], cc: [], bcc: [],
    receivedAt: '2026-06-20T10:00:00.000Z', sentAt: '2026-06-20T09:59:00.000Z', isRead: false, isDraft: false,
    conversationId: `conv-${n}`, internetMessageId: `<m${n}@acme.com>`, hasAttachments: false, body: { contentType: 'text', content: 'Hi' }, flag: { status: 'notFlagged', due: null }, ...over,
  };
}

const FOLDER_IDS = { inbox: 'id-inbox', sentitems: 'id-sent', drafts: 'id-drafts', deleteditems: 'id-deleted' };
const job = () => ({ id: 1, type: 'mail_backfill', payload: {}, attempts: 0, maxAttempts: 1 }) as unknown as Job;
const NEXT = (i: number) => `https://graph.microsoft.com/v1.0/me/messages?page=${i}`;

/** A graph whose search returns `pages` in turn (an Error is thrown); folderIds counted. */
function searching(pages: (SearchPage | Error)[], extra: Partial<ReturnType<typeof fakeGraph>> = {}) {
  const urls: string[] = [];
  let folderCalls = 0;
  const graph = fakeGraph({
    async searchPage(_account, url) {
      urls.push(url);
      const page = pages.shift() ?? { items: [] };
      if (page instanceof Error) throw page;
      return page;
    },
    async folderIds() {
      folderCalls += 1;
      return FOLDER_IDS;
    },
    ...extra,
  });
  return { graph, urls, folderCalls: () => folderCalls };
}

/** One queued row for `accountId` and ana@acme.com. */
async function queuedRow(accountId: number, over: { address?: string; nextLink?: string; attempts?: number } = {}) {
  return prisma.mailBackfill.create({ data: { accountId, address: over.address ?? 'ana@acme.com', nextLink: over.nextLink, attempts: over.attempts ?? 0 } });
}

const backfillJobs = () => prisma.job.findMany({ where: { type: 'mail_backfill' }, orderBy: { id: 'asc' } });

describe('queueing backfills', () => {
  it('the sweep queues one row per new address per connected mailbox, once; known addresses are not queued again', async () => {
    const a = await mailbox();
    const b = await mailbox();
    expect(await queueNewAddressBackfills(prisma)).toBe(4); // 2 addresses × 2 mailboxes
    expect(await queueNewAddressBackfills(prisma)).toBe(0);
    const rows = await prisma.mailBackfill.findMany({ orderBy: [{ accountId: 'asc' }, { address: 'asc' }] });
    expect(rows.map((r) => [r.accountId, r.address, r.status])).toEqual([
      [a.account.id, 'ana@acme.com', 'queued'], [a.account.id, 'bob@acme.com', 'queued'],
      [b.account.id, 'ana@acme.com', 'queued'], [b.account.id, 'bob@acme.com', 'queued'],
    ]);
    expect((await prisma.mailBackfillAddress.findMany()).map((r) => r.address).sort()).toEqual(['ana@acme.com', 'bob@acme.com']);
  });

  it('an address change queues rows for the new address only', async () => {
    await mailbox();
    await mailbox();
    await queueNewAddressBackfills(prisma);
    await prisma.lead.update({ where: { id: acme.leadId }, data: { businessEmail: 'bob.new@acme.com' } });
    await makeContact({ companyId: acme.companyId, businessEmail: 'ANA@acme.com' }); // same address, other case: known
    await makeContact({ companyId: acme.companyId, businessEmail: 'not-an-address' });
    expect(await queueNewAddressBackfills(prisma)).toBe(2);
    expect(await prisma.mailBackfill.count({ where: { address: 'bob.new@acme.com' } })).toBe(2);
  });

  it('a disconnected mailbox, Sync mail off or an inactive user gets no rows; a new mailbox gets none for known addresses', async () => {
    const ok = await mailbox();
    await mailbox({ status: 'disconnected' });
    await mailbox({ syncMail: false });
    await mailbox({ isActive: false });
    expect(await queueNewAddressBackfills(prisma)).toBe(2);
    expect(new Set((await prisma.mailBackfill.findMany()).map((r) => r.accountId))).toEqual(new Set([ok.account.id]));
    await mailbox();
    expect(await queueNewAddressBackfills(prisma)).toBe(0);
  });

  it('addresses at our own domain or a mailbox domain are never queued (F18), not even with --mailbox', async () => {
    const { account } = await mailbox();
    const other = await mailbox({ status: 'disconnected' });
    await prisma.emailAccount.update({ where: { id: other.account.id }, data: { address: 'me@ourbox.io' } });
    await makeContact({ companyId: acme.companyId, businessEmail: 'Colleague@DaitPartners.com' });
    await makeContact({ companyId: acme.companyId, businessEmail: 'sam@eu.daitpartners.com' });
    await makeContact({ companyId: acme.companyId, businessEmail: 'joe@ourbox.io' });
    expect(await queueNewAddressBackfills(prisma)).toBe(2); // ana and bob only
    expect((await prisma.mailBackfillAddress.findMany()).map((r) => r.address).sort()).toEqual(['ana@acme.com', 'bob@acme.com']);
    expect(await queueNewAddressBackfills(prisma)).toBe(0);
    // An own address recorded before (e.g. before this rule) is not queued for a reconnected mailbox either.
    await prisma.mailBackfillAddress.create({ data: { address: 'colleague@daitpartners.com' } });
    await prisma.mailBackfill.deleteMany({ where: { accountId: account.id } });
    expect(await queueMailboxBackfills(prisma, account.id)).toBe(2);
    expect(await prisma.mailBackfill.count({ where: { address: { contains: 'daitpartners.com' } } })).toBe(0);
  });

  it('a mailbox reconnected after the release gets rows for every known address with --mailbox (F20)', async () => {
    await mailbox();
    const late = await mailbox({ status: 'disconnected' });
    await queueNewAddressBackfills(prisma);
    await prisma.emailAccount.update({ where: { id: late.account.id }, data: { status: 'connected' } });
    expect(await queueMailboxBackfills(prisma, late.account.id)).toBe(2);
    expect(await prisma.mailBackfill.count({ where: { accountId: late.account.id, status: 'queued' } })).toBe(2);
    // Again: nothing new; a skipped row of that mailbox is queued again.
    await prisma.mailBackfill.updateMany({ where: { accountId: late.account.id, address: 'ana@acme.com' }, data: { status: 'skipped', attempts: 2 } });
    expect(await queueMailboxBackfills(prisma, late.account.id)).toBe(1);
    expect(await prisma.mailBackfill.findFirst({ where: { accountId: late.account.id, address: 'ana@acme.com' } })).toMatchObject({ status: 'queued', attempts: 0 });
    await expect(queueMailboxBackfills(prisma, 999_999)).rejects.toThrow('mailbox_not_found');
  });
});

describe('the backfill job', () => {
  it('searches 12 months, stores synced-folder mail with its CRM folder (Junk skipped), marks the row done with counts', async () => {
    const { user, account } = await mailbox();
    const row = await queuedRow(account.id);
    const { graph, urls } = searching([{
      items: [
        { folderId: 'id-inbox', message: msg() },
        { folderId: 'id-deleted', message: msg() },
        { folderId: 'id-junk', message: msg() },
      ],
    }]);

    await mailBackfillHandler(job(), { graph });

    const q = new URL(urls[0]!).searchParams.get('$search')!;
    expect(q).toContain('participants:ana@acme.com');
    const since = /received>=(\d{4}-\d{2}-\d{2})/.exec(q)![1]!;
    expect(Math.round((Date.now() - Date.parse(since)) / 86_400_000)).toBeGreaterThanOrEqual(365);
    expect(Math.round((Date.now() - Date.parse(since)) / 86_400_000)).toBeLessThanOrEqual(366);
    const after = await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'done', found: 3, stored: 2, nextLink: null });
    expect(after.finishedAt).toBeInstanceOf(Date);
    const stored = await prisma.emailMessage.findMany({ where: { userId: user.id } });
    expect(stored.map((m) => m.folder).sort()).toEqual(['deleted', 'inbox']);
    expect(stored.every((m) => m.leadId === acme.leadId && m.source === 'sync')).toBe(true);
  });

  it('a message already stored is not stored twice', async () => {
    const { user, account } = await mailbox();
    const m = msg();
    await queuedRow(account.id);
    const second = await queuedRow(account.id, { address: 'bob@acme.com' });
    const { graph } = searching([{ items: [{ folderId: 'id-inbox', message: m }] }, { items: [{ folderId: 'id-inbox', message: m }] }]);
    await mailBackfillHandler(job(), { graph });
    await mailBackfillHandler(job(), { graph });
    expect(await prisma.emailMessage.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'done', found: 1, stored: 0 });
  });

  it('folder ids are fetched once per mailbox and again only when an unknown folder shows up (F6)', async () => {
    const { account } = await mailbox();
    await queuedRow(account.id);
    await queuedRow(account.id, { address: 'bob@acme.com' });
    const { graph, folderCalls } = searching([
      { items: [{ folderId: 'id-inbox', message: msg() }, { folderId: 'id-junk', message: msg() }, { folderId: 'id-junk', message: msg() }] },
      { items: [{ folderId: 'id-sent', message: msg() }, { folderId: 'id-junk', message: msg() }, { folderId: 'id-new', message: msg() }, { folderId: 'id-new', message: msg() }] },
    ]);
    await mailBackfillHandler(job(), { graph });
    expect(folderCalls()).toBe(1); // first look-up; Junk is remembered as not synced
    await mailBackfillHandler(job(), { graph });
    expect(folderCalls()).toBe(2); // cached; one refresh for the id not seen before, then remembered
  });

  it('a long result stops after 5 pages, keeps the next link and continues on the next job', async () => {
    const { account } = await mailbox();
    const row = await queuedRow(account.id);
    const pages: SearchPage[] = Array.from({ length: 7 }, (_, i) => ({ items: [{ folderId: 'id-inbox', message: msg() }], nextLink: i < 6 ? NEXT(i + 1) : undefined }));
    const { graph, urls } = searching(pages);

    await mailBackfillHandler(job(), { graph });
    expect(urls).toHaveLength(BACKFILL_PAGES);
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'queued', nextLink: NEXT(5), found: 5, stored: 5 });

    await mailBackfillHandler(job(), { graph });
    expect(urls.slice(5)).toEqual([NEXT(5), NEXT(6)]);
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'done', nextLink: null, found: 7, stored: 7 });
  });

  it('a job stops after about 20 s even before 5 pages (F13)', async () => {
    const { account } = await mailbox();
    const row = await queuedRow(account.id);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const pages: SearchPage[] = Array.from({ length: 5 }, (_, i) => ({ items: [], nextLink: NEXT(i + 1) }));
    const { graph, urls } = searching(pages, {
      async searchPage(_account, url) {
        urls.push(url);
        offset += 11_000; // each page takes 11 s
        return pages.shift()!;
      },
    });
    await mailBackfillHandler(job(), { graph });
    expect(urls).toHaveLength(2);
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'queued', nextLink: NEXT(2) });
  });

  it('one job at a time: the next is queued 10 s later while rows remain, none when all are done', async () => {
    const { account } = await mailbox();
    await queuedRow(account.id);
    await queuedRow(account.id, { address: 'bob@acme.com' });
    const { graph } = searching([]);

    await mailBackfillHandler(job(), { graph });
    let jobs = await backfillJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxAttempts).toBe(1);
    const wait = jobs[0]!.runAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(8_000);
    expect(wait).toBeLessThanOrEqual(10_000);

    await mailBackfillHandler(job(), { graph });
    jobs = await backfillJobs();
    expect(jobs).toHaveLength(1); // no new job: nothing left to do
    expect(await prisma.mailBackfill.count({ where: { status: 'done' } })).toBe(2);
  });

  it('a 429 puts the row back to queued and the next job waits for Retry-After, at least 60 s (Review Focus 3)', async () => {
    const { account } = await mailbox();
    const row = await queuedRow(account.id);
    const { graph } = searching([new GraphError('graph_request_failed status=429 retry-after=120', 429)]);
    await mailBackfillHandler(job(), { graph });
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'queued', attempts: 0 });
    const [next] = await backfillJobs();
    expect(next!.runAt.getTime() - Date.now()).toBeGreaterThanOrEqual(119_000);

    await prisma.job.deleteMany();
    const short = searching([new GraphError('graph_request_failed status=429 retry-after=5', 429)]);
    await mailBackfillHandler(job(), { graph: short.graph });
    const [later] = await backfillJobs();
    expect(later!.runAt.getTime() - Date.now()).toBeGreaterThanOrEqual(59_000);
  });

  it('other failures retry the row 3 times, then failed; a revoked mailbox marks the row skipped', async () => {
    const { account } = await mailbox();
    const row = await queuedRow(account.id);
    for (const expected of ['queued', 'queued', 'failed']) {
      const { graph } = searching([new GraphError('graph_request_failed status=503', 503)]);
      await mailBackfillHandler(job(), { graph });
      expect((await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(expected);
    }
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attempts: 3, lastError: 'graph_request_failed status=503' });

    const other = await queuedRow(account.id, { address: 'bob@acme.com' });
    const { graph } = searching([new GraphError('graph_token_failed status=401', 401)]);
    await mailBackfillHandler(job(), { graph });
    expect(await prisma.mailBackfill.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'skipped', lastError: 'mailbox_needs_reconnect' });
  });

  it('a mailbox no longer connected, with Sync mail off or of an inactive user is skipped without a Graph call', async () => {
    const off = await mailbox({ syncMail: false });
    const gone = await mailbox({ status: 'disconnected' });
    const inactive = await mailbox({ isActive: false });
    for (const box of [off, gone, inactive]) await queuedRow(box.account.id);
    const graph = fakeGraph();
    for (let i = 0; i < 3; i++) await mailBackfillHandler(job(), { graph });
    expect((await prisma.mailBackfill.findMany()).map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('logs the row, account, status and counts only', async () => {
    const { account } = await mailbox();
    const row = await queuedRow(account.id);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { graph } = searching([{ items: [{ folderId: 'id-inbox', message: msg() }] }]);
    await mailBackfillHandler(job(), { graph });
    expect(log.mock.calls.map((c) => c.join(' '))).toEqual([`mail_backfill: row ${row.id} account ${account.id} done found=1 stored=1`]);
  });
});

describe('sweep, status and retry', () => {
  it('rows left running by a lost job go back to queued, and the sweep restarts a lost chain', async () => {
    const { account } = await mailbox();
    await queueNewAddressBackfills(prisma);
    const stale = new Date(Date.now() - STALE_AFTER_MS - 60_000);
    await prisma.mailBackfill.updateMany({ where: { address: 'ana@acme.com' }, data: { status: 'running', updatedAt: stale } });
    await prisma.mailBackfill.updateMany({ where: { address: 'bob@acme.com' }, data: { status: 'running' } }); // a live job's row
    // A running job locked long ago is lost too.
    const lost = await enqueue(prisma, 'mail_backfill', {}, { maxAttempts: 1 });
    await prisma.job.update({ where: { id: lost.id }, data: { status: 'running', lockedAt: stale } });

    await sweepMailBackfill(prisma);

    const rows = await prisma.mailBackfill.findMany({ where: { accountId: account.id }, orderBy: { address: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['queued', 'running']);
    expect((await backfillJobs()).filter((j) => j.status === 'queued')).toHaveLength(1);
    await sweepMailBackfill(prisma);
    expect((await backfillJobs()).filter((j) => j.status === 'queued')).toHaveLength(1); // not twice
    expect(await ensureBackfillJob(prisma)).toBe(false);
  });

  it('no job is queued when no row is waiting', async () => {
    expect(await ensureBackfillJob(prisma)).toBe(false);
    expect(await backfillJobs()).toHaveLength(0);
  });

  it('status counts rows by status and mailbox, with no lead addresses; retry re-queues failed and skipped', async () => {
    const a = await mailbox();
    const b = await mailbox();
    await queueNewAddressBackfills(prisma);
    await prisma.mailBackfill.updateMany({ where: { accountId: a.account.id, address: 'ana@acme.com' }, data: { status: 'done', found: 4, stored: 3 } });
    await prisma.mailBackfill.updateMany({ where: { accountId: a.account.id, address: 'bob@acme.com' }, data: { status: 'failed', attempts: 3, lastError: 'x' } });
    await prisma.mailBackfill.updateMany({ where: { accountId: b.account.id, address: 'ana@acme.com' }, data: { status: 'skipped', found: 1, stored: 1 } });

    const status = await backfillStatus(prisma);
    expect(status).toEqual({
      byStatus: { done: 1, failed: 1, skipped: 1, queued: 1 },
      found: 5, stored: 4,
      mailboxes: [
        { accountId: a.account.id, address: a.account.address, byStatus: { done: 1, failed: 1 } },
        { accountId: b.account.id, address: b.account.address, byStatus: { skipped: 1, queued: 1 } },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('ana@acme.com');
    expect(JSON.stringify(status)).not.toContain('bob@acme.com');

    expect(await retryBackfills(prisma)).toBe(2);
    expect((await backfillStatus(prisma)).byStatus).toEqual({ done: 1, queued: 3 });
    expect(await prisma.mailBackfill.findFirst({ where: { accountId: a.account.id, address: 'bob@acme.com' } })).toMatchObject({ attempts: 0 });
  });
});
