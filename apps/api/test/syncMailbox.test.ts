import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Job } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type DeltaPage, type GraphMessage } from '../src/graph/client';
import { syncMailboxHandler } from '../src/jobs/handlers/syncMailbox';
import { setBodyWorkerMemoryForTests } from '../src/mail/bodies';
import { requestSync, scheduleMailSync } from '../src/mail/schedule';
import { fakeGraph, resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser } from './factory';

beforeEach(async () => {
  await resetDb();
  boxes = 0;
});

const ADDRESS = 'maya@daitpartners.com';

let boxes = 0;
async function mailbox(over: { status?: string; syncMail?: boolean; syncState?: object; lastSyncAt?: Date } = {}) {
  const user = await makeUser({ role: 'SALES_REPRESENTATIVE' });
  boxes += 1;
  const account = await prisma.emailAccount.create({
    data: {
      userId: user.id, address: boxes === 1 ? ADDRESS : `box${boxes}@daitpartners.com`, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'),
      status: over.status ?? 'connected', syncMail: over.syncMail ?? true, syncState: over.syncState ?? {}, lastSyncAt: over.lastSyncAt ?? null,
    },
  });
  return { user, account };
}

let n = 0;
function msg(over: Partial<GraphMessage> = {}): GraphMessage {
  n += 1;
  return {
    id: `g${n}`, subject: 'Hello', from: { name: 'Ana Ruiz', address: 'ana@acme.com' }, to: [ADDRESS], cc: [],
    receivedAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T09:59:00.000Z', isRead: false, isDraft: false,
    conversationId: `conv-${n}`, internetMessageId: `<m${n}@acme.com>`, hasAttachments: false, body: { contentType: 'text', content: 'Hi Maya' }, ...over,
  };
}

/** Pages by URL; a folder's start URL is matched by its folder name. Unscripted URLs return an empty final page. */
function scripted(pages: Record<string, DeltaPage | Error>, extra: Partial<ReturnType<typeof fakeGraph>> = {}) {
  const seen: string[] = [];
  const graph = fakeGraph({
    async deltaPage(_account, url) {
      seen.push(url);
      const folder = /mailFolders\/(\w+)\/messages\/delta/.exec(url)?.[1];
      const page = pages[url] ?? (folder ? pages[`start:${folder}`] : undefined);
      if (page instanceof Error) throw page;
      return page ?? { messages: [], removed: [], deltaLink: `https://graph.microsoft.com/v1.0/delta/${folder ?? 'x'}/done` };
    },
    async attachmentNames() {
      return ['quote.pdf'];
    },
    ...extra,
  });
  return { graph, seen };
}

const job = (accountId: number, attempts = 0) => ({ id: 1, type: 'sync_mailbox', payload: { accountId }, attempts, maxAttempts: 1 }) as unknown as Job;
const final = (folder: string, messages: GraphMessage[], removed: string[] = []): DeltaPage =>
  ({ messages, removed, deltaLink: `https://graph.microsoft.com/v1.0/delta/${folder}/1` });

describe('mail sync (2B-2)', () => {
  test('a first run stores each folder’s mail with status, links and attachments, and keeps the delta links', async () => {
    const { user, account } = await mailbox();
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: user.id });
    const inbound = msg({ hasAttachments: true });
    const sent = msg({ from: { name: 'Maya', address: ADDRESS }, to: ['ana@acme.com'], isRead: true, subject: 'Proposal' });
    const draft = msg({ from: { name: 'Maya', address: ADDRESS }, to: ['x@gmail.com'], isDraft: true, subject: 'Draft' });
    const { graph, seen } = scripted({ 'start:inbox': final('inbox', [inbound]), 'start:sentitems': final('sentitems', [sent]), 'start:drafts': final('drafts', [draft]) });

    await syncMailboxHandler(job(account.id), { graph });

    expect(seen.filter((u) => u.includes('/mailFolders/')).map((u) => /mailFolders\/(\w+)/.exec(u)![1])).toEqual(['inbox', 'sentitems', 'drafts', 'archive']);
    const since = new URL(seen[0]!).searchParams.get('$filter')!.slice('receivedDateTime ge '.length);
    expect(Math.round((Date.now() - Date.parse(since)) / 86_400_000)).toBe(90);
    const rows = await prisma.emailMessage.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.folder, r.status, r.source, r.isRead])).toEqual([
      ['inbox', 'received', 'sync', false], ['sent', 'sent', 'sync', true], ['drafts', 'draft', 'sync', true],
    ]);
    expect(rows[0]).toMatchObject({
      graphId: inbound.id, fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz', subject: 'Hello', bodyText: 'Hi Maya', threadId: inbound.conversationId,
      messageId: inbound.internetMessageId, attachmentNames: ['quote.pdf'], leadId: lead.id, contactId: contact.id, companyId: company.id, accountId: account.id,
      occurredAt: new Date(inbound.receivedAt),
    });
    expect(rows[1]).toMatchObject({ leadId: lead.id, occurredAt: new Date(sent.sentAt!) });
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.syncState).toEqual({
      inbox: { link: 'https://graph.microsoft.com/v1.0/delta/inbox/1' }, sentitems: { link: 'https://graph.microsoft.com/v1.0/delta/sentitems/1' },
      drafts: { link: 'https://graph.microsoft.com/v1.0/delta/drafts/1' }, archive: { link: 'https://graph.microsoft.com/v1.0/delta/archive/done' },
    });
    expect(after.lastSyncAt).toBeInstanceOf(Date);
    expect(after.messageCount).toBe(3);
  });

  test('a later run continues from the stored links', async () => {
    const link = 'https://graph.microsoft.com/v1.0/delta/inbox/1';
    const { account } = await mailbox({ syncState: { inbox: { link } } });
    const { graph, seen } = scripted({});
    await syncMailboxHandler(job(account.id), { graph });
    expect(seen[0]).toBe(link);
  });

  test('a message the CRM sent takes its Graph id instead of becoming a second row, even as "RE:"', async () => {
    const { user, account } = await mailbox();
    const crm = await prisma.emailMessage.create({
      data: {
        userId: user.id, accountId: account.id, folder: 'sent', status: 'sent', source: 'crm', fromAddress: ADDRESS, toAddresses: ['ana@acme.com'],
        subject: 'Re: Proposal', occurredAt: new Date('2026-11-20T09:55:00.000Z'),
      },
    });
    const copy = msg({ from: { name: 'Maya', address: ADDRESS }, to: ['ana@acme.com'], subject: 'RE: Proposal', sentAt: '2026-11-20T10:01:00.000Z' });
    const { graph } = scripted({ 'start:sentitems': final('sentitems', [copy]) });
    await syncMailboxHandler(job(account.id), { graph });
    const rows = await prisma.emailMessage.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: crm.id, graphId: copy.id, threadId: copy.conversationId, source: 'crm' });
  });

  test('an existing message keeps the links the user made and takes the new read flag and folder', async () => {
    const { user, account } = await mailbox();
    const lead = await makeLead({ assignedToId: user.id });
    const m = msg();
    await prisma.emailMessage.create({
      data: { userId: user.id, accountId: account.id, graphId: m.id, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', subject: 'Hello', isRead: false, leadId: lead.id },
    });
    const { graph } = scripted({ 'start:archive': final('archive', [{ ...m, isRead: true }]) });
    await syncMailboxHandler(job(account.id), { graph });
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { graphId: m.id } });
    expect(row).toMatchObject({ folder: 'archive', isRead: true, leadId: lead.id });
  });

  test('a message moved from Inbox to Archive in one run keeps its row; one deleted is removed; a CRM one keeps its row', async () => {
    const { user, account } = await mailbox();
    const lead = await makeLead({ assignedToId: user.id });
    const base = { userId: user.id, accountId: account.id, status: 'received', fromAddress: 'ana@acme.com', subject: 's' };
    const moved = await prisma.emailMessage.create({ data: { ...base, graphId: 'moved', folder: 'inbox', source: 'sync', leadId: lead.id } });
    await prisma.emailMessage.create({ data: { ...base, graphId: 'gone', folder: 'inbox', source: 'sync' } });
    const crm = await prisma.emailMessage.create({ data: { ...base, graphId: 'crm-sent', folder: 'sent', status: 'sent', source: 'crm' } });
    const { graph } = scripted({
      'start:inbox': final('inbox', [], ['moved', 'gone']),
      'start:sentitems': final('sentitems', [], ['crm-sent']),
      'start:archive': final('archive', [msg({ id: 'moved' })]),
    });
    await syncMailboxHandler(job(account.id), { graph });
    const rows = await prisma.emailMessage.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.folder, r.graphId, r.leadId])).toEqual([[moved.id, 'archive', 'moved', lead.id], [crm.id, 'sent', null, null]]);
  });

  test('a long first sync stops after 20 pages per folder and runs again in about a minute', async () => {
    const { account } = await mailbox();
    const pages: Record<string, DeltaPage> = {};
    for (let i = 0; i < 25; i++) {
      pages[i === 0 ? 'start:inbox' : `https://graph.microsoft.com/v1.0/p/${i}`] = { messages: [msg()], removed: [], nextLink: `https://graph.microsoft.com/v1.0/p/${i + 1}` };
    }
    const { graph } = scripted(pages);
    await syncMailboxHandler(job(account.id), { graph });
    expect(await prisma.emailMessage.count()).toBe(20);
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect((after.syncState as Record<string, { link: string }>).inbox!.link).toBe('https://graph.microsoft.com/v1.0/p/20');
    const next = await prisma.job.findFirstOrThrow({ where: { type: 'sync_mailbox', status: 'queued' } });
    expect(next.payload).toEqual({ accountId: account.id });
    expect(next.runAt.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(next.runAt.getTime() - Date.now()).toBeLessThan(90_000);
  });

  test('an expired delta link restarts that folder', async () => {
    const stale = 'https://graph.microsoft.com/v1.0/delta/inbox/old';
    const { account } = await mailbox({ syncState: { inbox: { link: stale } } });
    const fresh = msg();
    const { graph, seen } = scripted({ [stale]: new GraphError('graph_request_failed status=410', 410), 'start:inbox': final('inbox', [fresh]) });
    await syncMailboxHandler(job(account.id), { graph });
    expect(seen[1]).toContain('/mailFolders/inbox/messages/delta');
    expect(await prisma.emailMessage.count({ where: { graphId: fresh.id } })).toBe(1);
  });

  test('a folder that keeps failing is skipped: the others are saved and their removals applied, and the run completes', async () => {
    const { user, account } = await mailbox();
    await prisma.emailMessage.create({ data: { userId: user.id, accountId: account.id, graphId: 'deleted', folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'a@b.com', subject: 's' } });
    const fresh = msg();
    const { graph } = scripted({
      'start:inbox': final('inbox', [fresh], ['deleted']),
      'start:archive': new GraphError('graph_request_failed status=404 code=ErrorItemNotFound', 404),
    });
    await syncMailboxHandler(job(account.id), { graph });
    expect((await prisma.emailMessage.findMany({ where: { userId: user.id } })).map((r) => r.graphId)).toEqual([fresh.id]);
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.lastSyncAt).toBeInstanceOf(Date);
    expect(after.lastError).toContain('archive');
    const state = after.syncState as Record<string, unknown>;
    expect(state.inbox).toBeDefined();
    expect(state.archive).toBeUndefined();
  });

  test('a folder failing after some pages keeps its old link, so its removals are read again next time', async () => {
    const old = 'https://graph.microsoft.com/v1.0/delta/inbox/old';
    const { user, account } = await mailbox({ syncState: { inbox: { link: old } } });
    await prisma.emailMessage.create({ data: { userId: user.id, accountId: account.id, graphId: 'deleted', folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'a@b.com', subject: 's' } });
    const { graph } = scripted({
      [old]: { messages: [], removed: ['deleted'], nextLink: 'https://graph.microsoft.com/v1.0/p/2' },
      'https://graph.microsoft.com/v1.0/p/2': new GraphError('graph_request_failed status=503', 503),
    });
    await syncMailboxHandler(job(account.id), { graph });
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect((after.syncState as Record<string, { link: string }>).inbox!.link).toBe(old);
    expect(await prisma.emailMessage.count({ where: { graphId: 'deleted' } })).toBe(1);
  });

  test('when every folder fails the run fails', async () => {
    const { account } = await mailbox();
    const down = new GraphError('graph_request_failed status=503', 503);
    const { graph } = scripted({ 'start:inbox': down, 'start:sentitems': down, 'start:drafts': down, 'start:archive': down });
    await expect(syncMailboxHandler(job(account.id), { graph })).rejects.toThrow('503');
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).lastSyncAt).toBeNull();
  });

  test('a revoked token puts the mailbox in error and stops', async () => {
    const { account } = await mailbox();
    const { graph } = scripted({ 'start:inbox': new GraphError('graph_request_failed status=401', 401) });
    await syncMailboxHandler(job(account.id), { graph });
    const after = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('401');
  });

  test('other failures leave the mailbox connected', async () => {
    const { account } = await mailbox();
    const down = new GraphError('graph_request_failed status=503', 503);
    const { graph } = scripted({ 'start:inbox': down, 'start:sentitems': down, 'start:drafts': down, 'start:archive': down });
    await expect(syncMailboxHandler(job(account.id), { graph })).rejects.toThrow('503');
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe('connected');
  });

  test('a disconnected mailbox, or one with Sync mail off, is not read', async () => {
    const a = await mailbox({ status: 'disconnected' });
    const { graph, seen } = scripted({});
    await syncMailboxHandler(job(a.account.id), { graph });
    await prisma.emailAccount.update({ where: { id: a.account.id }, data: { status: 'connected', syncMail: false } });
    await syncMailboxHandler(job(a.account.id), { graph });
    expect(seen).toEqual([]);
  });

  test('the same Graph id synced for two users gives each their own row', async () => {
    const a = await mailbox();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await prisma.emailMessage.create({ data: { userId: other.id, graphId: 'same', folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'x@y.com', subject: 'theirs' } });
    const { graph } = scripted({ 'start:inbox': final('inbox', [msg({ id: 'same', subject: 'mine' })]) });
    await syncMailboxHandler(job(a.account.id), { graph });
    expect((await prisma.emailMessage.findMany({ where: { graphId: 'same' }, orderBy: { id: 'asc' } })).map((r) => [r.userId, r.subject]))
      .toEqual([[other.id, 'theirs'], [a.user.id, 'mine']]);
  });

  test('a draft sent from Outlook becomes sent', async () => {
    const { user, account } = await mailbox();
    const m = msg({ from: { name: 'Maya', address: ADDRESS }, to: ['ana@acme.com'], isDraft: true, subject: 'Proposal' });
    await prisma.emailMessage.create({
      data: { userId: user.id, accountId: account.id, graphId: m.id, folder: 'drafts', status: 'draft', source: 'sync', fromAddress: ADDRESS, subject: 'Proposal' },
    });
    const sentAt = '2026-11-21T08:30:00.000Z';
    const { graph } = scripted({ 'start:sentitems': final('sentitems', [{ ...m, isDraft: false, sentAt, receivedAt: '2026-11-21T08:30:05.000Z' }]) });
    await syncMailboxHandler(job(account.id), { graph });
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { graphId: m.id } });
    expect(row).toMatchObject({ status: 'sent', folder: 'sent', occurredAt: new Date(sentAt) });
  });

  test("message count counts only the current owner's mail", async () => {
    const { user: first, account } = await mailbox();
    const second = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const row = (userId: number, i: number) => ({
      userId, accountId: account.id, graphId: `old-${userId}-${i}`, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'a@b.com', subject: 's',
    });
    await prisma.emailMessage.createMany({ data: [0, 1, 2].map((i) => row(first.id, i)) });
    await prisma.emailMessage.createMany({ data: [0, 1].map((i) => row(second.id, i)) });
    await prisma.emailAccount.update({ where: { id: account.id }, data: { userId: second.id } });
    const { graph } = scripted({});
    await syncMailboxHandler(job(account.id), { graph });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).messageCount).toBe(2);
  });

  test('long bodies are cut to 50,000 characters', async () => {
    const { account } = await mailbox();
    const { graph } = scripted({ 'start:inbox': final('inbox', [msg({ body: { contentType: 'text', content: 'x'.repeat(60_000) } })]) });
    await syncMailboxHandler(job(account.id), { graph });
    expect((await prisma.emailMessage.findFirstOrThrow()).bodyText).toHaveLength(50_000);
  });

  test('an HTML body is stored sanitised, with text derived from it (no CSS or markup); a long one is capped too', async () => {
    const { account } = await mailbox();
    const html = `<html><head><title>Offer</title><style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style></head>
      <body><p>Hello <b>Maya</b>,</p><p>Our <a class="btn" href="https://acme.com/offer" onclick="track()">offer</a> is ready.</p>
      <script>steal()</script><img src="cid:logo@01" alt="logo"></body></html>`;
    const long = `<div>${'<p>Paragraph text here.</p>'.repeat(5000)}</div>`;
    const { graph } = scripted({
      'start:inbox': final('inbox', [msg({ subject: 'Offer', body: { contentType: 'html', content: html } }), msg({ subject: 'Long', body: { contentType: 'html', content: long } })]),
    });
    await syncMailboxHandler(job(account.id), { graph });
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { subject: 'Offer' } });
    expect(row.bodyText).toBe('Hello Maya,\n\nOur offer is ready.');
    expect(row.bodyHtml).toContain('<b>Maya</b>');
    expect(row.bodyHtml).toContain('<style>.btn{color:#fff;background:#0a66c2} p{margin:0}</style>');
    expect(row.bodyHtml).toContain('href="https://acme.com/offer" target="_blank" rel="noopener noreferrer"');
    expect(row.bodyHtml).not.toMatch(/onclick|script|steal|cid:|Offer<\/title>/);
    const big = await prisma.emailMessage.findFirstOrThrow({ where: { subject: 'Long' } });
    expect(big.bodyHtml!.length).toBeLessThanOrEqual(50_000);
    expect(big.bodyText.length).toBeLessThanOrEqual(50_000);
  });

  test('a body too complex to process in time is stored with no HTML and plain fallback text; the sync carries on', async () => {
    const { account } = await mailbox();
    const hostile = '<style>p{color:red}</style><p>Read me</p>' + '<div>'.repeat(400_000) + 'past the 1 MB cap';
    const { graph } = scripted({
      'start:inbox': final('inbox', [msg({ subject: 'Hostile', body: { contentType: 'html', content: hostile } }), msg({ subject: 'Next', body: { contentType: 'html', content: '<p>fine</p>' } })]),
    });
    await syncMailboxHandler(job(account.id), { graph });
    expect(await prisma.emailMessage.findFirstOrThrow({ where: { subject: 'Hostile' } })).toMatchObject({ bodyHtml: '', bodyText: 'Read me' });
    expect(await prisma.emailMessage.findFirstOrThrow({ where: { subject: 'Next' } })).toMatchObject({ bodyHtml: '<p>fine</p>', bodyText: 'fine' });
  });

  test('a body whose worker crashed is kept for one retry (null), then plain text (\'\'); each fallback is logged by id and reason only', async () => {
    const { account } = await mailbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const big = msg({ id: 'g-crash', subject: 'Big', body: { contentType: 'html', content: '<p>big secret words</p>'.repeat(40_000) } });
    const { graph } = scripted({ 'start:inbox': final('inbox', [big]) });
    setBodyWorkerMemoryForTests(16);
    try {
      await syncMailboxHandler(job(account.id), { graph });
      const row = await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'g-crash' } });
      expect(row.bodyHtml).toBeNull();
      expect(row.bodyText.startsWith('big secret words')).toBe(true);
      // The next sync brings it again: the one retry crashes too, and it stays plain text.
      await prisma.emailAccount.update({ where: { id: account.id }, data: { syncState: {} } });
      await syncMailboxHandler(job(account.id), { graph });
      expect((await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'g-crash' } })).bodyHtml).toBe('');
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('fell back'));
      expect(lines).toEqual([
        `sync_mailbox: email_message ${row.id}: body fell back to plain text (crash)`,
        `sync_mailbox: email_message ${row.id}: body fell back to plain text (crash)`,
      ]);
      expect(lines.join(' ')).not.toContain('secret');
    } finally {
      setBodyWorkerMemoryForTests(null);
      warn.mockRestore();
    }
  });

  test('a plain-text body is stored as text with no HTML', async () => {
    const { account } = await mailbox();
    const { graph } = scripted({ 'start:inbox': final('inbox', [msg({ body: { contentType: 'text', content: 'Line 1\nLine 2' } })]) });
    await syncMailboxHandler(job(account.id), { graph });
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ bodyText: 'Line 1\nLine 2', bodyHtml: null });
  });

  test('a row synced before HTML bodies gets its HTML (and cleaner text) when the message comes again; one that has it keeps it', async () => {
    const { user, account } = await mailbox();
    const old = msg({ id: 'old-1' });
    const kept = msg({ id: 'kept-1' });
    const base = { userId: user.id, accountId: account.id, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', subject: 'Hello' };
    await prisma.emailMessage.create({ data: { ...base, graphId: 'old-1', bodyText: '.x{color:red} Hello' } });
    await prisma.emailMessage.create({ data: { ...base, graphId: 'kept-1', bodyText: 'Kept', bodyHtml: '<p>Kept</p>' } });
    const { graph } = scripted({
      'start:inbox': final('inbox', [{ ...old, body: { contentType: 'html', content: '<style>.x{color:red}</style><p>Hello</p>' } }, { ...kept, body: { contentType: 'html', content: '<p>New</p>' } }]),
    });
    await syncMailboxHandler(job(account.id), { graph });
    expect(await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'old-1' } })).toMatchObject({ bodyHtml: '<style>.x{color:red}</style><p>Hello</p>', bodyText: 'Hello' });
    expect(await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'kept-1' } })).toMatchObject({ bodyHtml: '<p>Kept</p>', bodyText: 'Kept' });
  });
});

describe('mail sync scheduling (2B-2)', () => {
  test('one job per connected mailbox with Sync mail on, 5 minutes after its last sync, never two', async () => {
    const recent = new Date(Date.now() - 60_000);
    const a = await mailbox({ lastSyncAt: recent });
    const b = await mailbox();
    await mailbox({ status: 'error' });
    await mailbox({ syncMail: false });
    expect(await scheduleMailSync(prisma)).toBe(2);
    expect(await scheduleMailSync(prisma)).toBe(0);
    const jobs = await prisma.job.findMany({ where: { type: 'sync_mailbox' }, orderBy: { id: 'asc' } });
    expect(jobs.map((j) => j.payload)).toEqual([{ accountId: a.account.id }, { accountId: b.account.id }]);
    expect(jobs[0]!.runAt.getTime()).toBe(recent.getTime() + 5 * 60_000);
    expect(jobs[1]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("no sync is queued for a deactivated user's mailbox", async () => {
    const { user } = await mailbox();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect(await scheduleMailSync(prisma)).toBe(0);
  });

  test("a run already queued when the user is deactivated reads nothing from the mailbox", async () => {
    const { user, account } = await mailbox();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    const { graph, seen } = scripted({});
    await syncMailboxHandler(job(account.id), { graph });
    expect(seen).toEqual([]);
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  test('after a failed run the next one waits 5 minutes, not one', async () => {
    const { account } = await mailbox({ lastSyncAt: new Date(Date.now() - 3600_000) });
    const failedAt = new Date(Date.now() - 60_000);
    await prisma.job.create({ data: { type: 'sync_mailbox', payload: { accountId: account.id }, status: 'failed', runAt: failedAt, updatedAt: failedAt } });
    await scheduleMailSync(prisma);
    const next = await prisma.job.findFirstOrThrow({ where: { type: 'sync_mailbox', status: 'queued' } });
    expect(Math.abs(next.runAt.getTime() - (failedAt.getTime() + 5 * 60_000))).toBeLessThan(1000);
  });

  test('requestSync brings a queued run forward, or queues one now', async () => {
    const { account } = await mailbox({ lastSyncAt: new Date() });
    await scheduleMailSync(prisma);
    await requestSync(prisma, account.id);
    const jobs = await prisma.job.findMany({ where: { type: 'sync_mailbox' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    await prisma.job.deleteMany();
    await requestSync(prisma, account.id);
    expect(await prisma.job.count({ where: { type: 'sync_mailbox', status: 'queued' } })).toBe(1);
  });
});


describe('project tag on synced replies (3B)', () => {
  test('a reply in a conversation whose earlier message of yours carries a project inherits the latest one', async () => {
    const { user, account } = await mailbox();
    const other = await mailbox();
    const company = await makeCompany({ website: 'https://acme.com' });
    const older = await makeProject({ companyId: company.id, managerId: user.id });
    const latest = await makeProject({ companyId: company.id, managerId: user.id });
    const theirs = await makeProject({ companyId: company.id, managerId: other.user.id });
    const base = { accountId: account.id, folder: 'sent', status: 'sent', source: 'crm', fromAddress: ADDRESS, subject: 'Kick-off', threadId: 'conv-p' };
    await prisma.emailMessage.create({ data: { ...base, userId: user.id, projectId: older.id, occurredAt: new Date('2026-11-18T10:00:00Z') } });
    await prisma.emailMessage.create({ data: { ...base, userId: user.id, projectId: latest.id, occurredAt: new Date('2026-11-19T10:00:00Z') } });
    await prisma.emailMessage.create({ data: { ...base, userId: user.id, projectId: null, occurredAt: new Date('2026-11-19T12:00:00Z') } });
    // Another user's message in a conversation of the same id never lends its project.
    await prisma.emailMessage.create({ data: { ...base, accountId: other.account.id, userId: other.user.id, threadId: 'conv-q', projectId: theirs.id, occurredAt: new Date('2026-11-19T10:00:00Z') } });
    const reply = msg({ conversationId: 'conv-p', subject: 'RE: Kick-off' });
    const unrelated = msg({ conversationId: 'conv-q', subject: 'Other' });
    const { graph } = scripted({ 'start:inbox': final('inbox', [reply, unrelated]) });
    await syncMailboxHandler(job(account.id), { graph });
    expect((await prisma.emailMessage.findFirstOrThrow({ where: { graphId: reply.id } })).projectId).toBe(latest.id);
    expect((await prisma.emailMessage.findFirstOrThrow({ where: { graphId: unrelated.id, userId: user.id } })).projectId).toBeNull();
  });
});
