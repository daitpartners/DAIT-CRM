import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/db';
import { claimNext, complete, enqueue, fail } from '../src/jobs/queue';
import { sendSystemEmail } from '../src/email/system';
import { resetDb } from './helpers';

const payload = { to: ['a@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

beforeEach(async () => {
  await resetDb();
});

describe('job queue', () => {
  test('claimNext returns null when empty', async () => {
    expect(await claimNext(['send_email'])).toBeNull();
  });

  test('claims a due job once', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    expect(job.status).toBe('queued');
    const claimed = await claimNext(['send_email']);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.lockedAt).toBeInstanceOf(Date);
    expect(claimed?.payload).toEqual(payload);
    expect(await claimNext(['send_email'])).toBeNull();
  });

  test('concurrent claimers never get the same job', async () => {
    await enqueue(prisma, 'send_email', payload);
    await enqueue(prisma, 'send_email', payload);
    const results = await Promise.all([claimNext(['send_email']), claimNext(['send_email']), claimNext(['send_email'])]);
    const ids = results.filter((r) => r !== null).map((r) => r!.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('skips future jobs and other types', async () => {
    await enqueue(prisma, 'send_email', payload, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimNext(['send_email'])).toBeNull();
    await enqueue(prisma, 'send_email', payload);
    expect(await claimNext([] as never[])).toBeNull();
  });

  test('complete marks done', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    await claimNext(['send_email']);
    await complete(job.id);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('done');
    expect(after.lockedAt).toBeNull();
  });

  test('retries with backoff', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    await claimNext(['send_email']);
    const before = Date.now();
    await fail(job.id, new Error('boom'));
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBe('boom');
    expect(after.lockedAt).toBeNull();
    const delta = after.runAt.getTime() - before;
    expect(delta).toBeGreaterThan(2 * 60_000 - 5_000);
    expect(delta).toBeLessThan(2 * 60_000 + 5_000);
  });

  test('marks failed after max attempts', async () => {
    const job = await enqueue(prisma, 'send_email', payload, { maxAttempts: 2 });
    await fail(job.id, new Error('one'));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('queued');
    await fail(job.id, new Error('two'));
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(2);
    expect(after.lastError).toBe('two');
  });

  test('backoff is capped at 60 minutes', async () => {
    const job = await enqueue(prisma, 'send_email', payload, { maxAttempts: 20 });
    await prisma.job.update({ where: { id: job.id }, data: { attempts: 9 } });
    const before = Date.now();
    await fail(job.id, new Error('x'));
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.runAt.getTime() - before).toBeLessThan(60 * 60_000 + 5_000);
    expect(after.runAt.getTime() - before).toBeGreaterThan(60 * 60_000 - 5_000);
  });

  test('sendSystemEmail enqueues send_email inside a transaction', async () => {
    await prisma.$transaction((tx) => sendSystemEmail(tx, payload));
    const jobs = await prisma.job.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'send_email', status: 'queued', attempts: 0, maxAttempts: 8 });
  });
});
