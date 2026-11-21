import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EmailAccount } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import type { GraphClient, MailMessage } from '../src/graph/client';
import { GraphError, createGraphClient } from '../src/graph/client';
import { enqueue } from '../src/jobs/queue';
import { runOnce } from '../src/jobs/runner';
import { sendEmailHandler } from '../src/jobs/handlers/sendEmail';
import { fakeGraph, resetDb } from './helpers';

const payload = { to: ['client@example.com'], cc: ['boss@example.com'], subject: 'Quote', html: '<p>Q</p>', text: 'Q' };

function recordingGraph(error?: Error): GraphClient & { calls: { account: EmailAccount; msg: MailMessage }[] } {
  const calls: { account: EmailAccount; msg: MailMessage }[] = [];
  return {
    ...fakeGraph(),
    calls,
    async sendMail(account, msg) {
      calls.push({ account, msg });
      if (error) throw error;
    },
  };
}

async function systemAccount(status = 'connected') {
  return prisma.emailAccount.create({
    data: { address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt('rt'), status },
  });
}

const run = (graph: GraphClient) => runOnce({ types: ['send_email'], handlers: { send_email: sendEmailHandler }, graph });

beforeEach(async () => {
  await resetDb();
});

afterEach(() => vi.unstubAllEnvs());

describe('send_email handler', () => {
  test('a token stored under an old TOKEN_ENCRYPTION_KEY marks the mailbox token_unreadable', async () => {
    const account = await systemAccount();
    const job = await enqueue(prisma, 'send_email', payload);
    // A different 32-byte key (0x08 repeated) than the one the token was encrypted with.
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', Buffer.alloc(32, 8).toString('base64'));
    const graph = createGraphClient({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' });
    expect(await run(graph)).toBe(true);
    const acc = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc).toMatchObject({ status: 'error', lastError: 'token_unreadable' });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: 'queued', attempts: 1, lastError: 'token_unreadable' });
  });

  test('sends through the connected system mailbox', async () => {
    const account = await systemAccount();
    const job = await enqueue(prisma, 'send_email', { ...payload, relatedTo: { entityType: 'lead', entityId: '1' } });
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]!.account.id).toBe(account.id);
    expect(graph.calls[0]!.msg).toEqual(payload);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('done');
  });

  test('no system mailbox: job is failed and requeued', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls).toHaveLength(0);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: 'queued', attempts: 1, lastError: 'no_system_mailbox' });
  });

  test('ignores a system mailbox in error state', async () => {
    await systemAccount('error');
    const job = await enqueue(prisma, 'send_email', payload);
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls).toHaveLength(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).lastError).toBe('no_system_mailbox');
  });

  test('auth failure marks the mailbox as error', async () => {
    const account = await systemAccount();
    const job = await enqueue(prisma, 'send_email', payload);
    await run(recordingGraph(new GraphError('graph_send_failed status=401', 401)));
    const acc = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.status).toBe('error');
    expect(acc.lastError).toContain('401');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('queued');
  });

  test('invalid_grant marks the mailbox as error', async () => {
    const account = await systemAccount();
    await enqueue(prisma, 'send_email', payload);
    await run(recordingGraph(Object.assign(new Error('AADSTS700082: expired'), { errorCode: 'invalid_grant' })));
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe('error');
  });

  test('throttling and server errors leave the mailbox connected', async () => {
    const account = await systemAccount();
    const job = await enqueue(prisma, 'send_email', payload);
    await run(recordingGraph(new GraphError('graph_send_failed status=429 retry-after=30', 429)));
    await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    await run(recordingGraph(new GraphError('graph_send_failed status=503', 503)));
    const acc = await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.status).toBe('connected');
    expect(acc.lastError).toBeNull();
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: 'queued', attempts: 2, lastError: 'graph_send_failed status=503' });
  });
});
