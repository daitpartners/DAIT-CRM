import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { WORKER_LANES } from '../src/worker';
import { JOB_TYPES } from '../src/jobs/types';
import { enqueue } from '../src/jobs/queue';
import { runOnce } from '../src/jobs/runner';
import { fakeGraph, resetDb } from './helpers';

beforeEach(resetDb);

const lane = (name: string) => WORKER_LANES.find((l) => l.name === name)!;

describe('worker lanes', () => {
  it('research and import have lanes of their own; every job type is in exactly one lane', () => {
    expect(lane('research').types).toEqual(['research_company', 'import_research']);
    expect(lane('mail').types).not.toContain('research_company');
    expect(lane('import').types).toEqual(['import_read_file', 'import_commit']);
    expect(JOB_TYPES).toContain('import_research');
    const all = WORKER_LANES.flatMap((l) => l.types);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...JOB_TYPES].sort());
  });

  it('send_user_email has its own lane', async () => {
    expect(lane('send').types).toEqual(['send_user_email']);
    expect(lane('mail').types).not.toContain('send_user_email');
    // A user's send is claimed while a mail job (a sync) waits, and the mail lane never takes the send.
    const sync = await enqueue(prisma, 'sync_mailbox', { accountId: 1 });
    const send = await enqueue(prisma, 'send_user_email', { emailMessageId: 1 });
    const seen: string[] = [];
    const handlers = { sync_mailbox: async () => { seen.push('sync'); }, send_user_email: async () => { seen.push('send'); } };
    const graph = fakeGraph();
    expect(await runOnce({ types: [...lane('mail').types], handlers, graph })).toBe(true);
    expect(await runOnce({ types: [...lane('mail').types], handlers, graph })).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: send.id } })).status).toBe('queued');
    expect(await runOnce({ types: [...lane('send').types], handlers, graph })).toBe(true);
    expect(seen).toEqual(['sync', 'send']);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: sync.id } })).status).toBe('done');
  });

  it('the mail lane never claims a research job and the research lane never claims a mail job', async () => {
    const research = await enqueue(prisma, 'research_company', { runId: 1 });
    const mail = await enqueue(prisma, 'send_email', { to: ['a@b.c'], subject: 's', html: '', text: '' });
    const seen: string[] = [];
    const handlers = { research_company: async () => { seen.push('research'); }, send_email: async () => { seen.push('mail'); } };
    const graph = fakeGraph();

    expect(await runOnce({ types: [...lane('research').types], handlers, graph })).toBe(true);
    expect(await runOnce({ types: [...lane('research').types], handlers, graph })).toBe(false);
    expect(seen).toEqual(['research']);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: mail.id } })).status).toBe('queued');

    expect(await runOnce({ types: [...lane('mail').types], handlers, graph })).toBe(true);
    expect(seen).toEqual(['research', 'mail']);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: research.id } })).status).toBe('done');
  });
});
