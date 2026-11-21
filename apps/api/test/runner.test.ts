import { beforeEach, describe, expect, test } from 'vitest';
import type { Job } from '@prisma/client';
import { prisma } from '../src/db';
import { enqueue } from '../src/jobs/queue';
import { runForever, runOnce } from '../src/jobs/runner';
import type { GraphClient } from '../src/graph/client';
import { fakeGraph, resetDb } from './helpers';

const graph: GraphClient = fakeGraph({ async sendMail() {} });
const payload = { to: ['a@example.com'], subject: 's', html: 'h', text: 't' };

beforeEach(async () => {
  await resetDb();
});

describe('job runner', () => {
  test('runOnce returns false when idle', async () => {
    expect(await runOnce({ types: ['send_email'], handlers: {}, graph })).toBe(false);
  });

  test('runOnce runs an in-process handler and completes the job', async () => {
    const seen: Job[] = [];
    const job = await enqueue(prisma, 'send_email', payload);
    const ok = await runOnce({ types: ['send_email'], handlers: { send_email: async (j) => void seen.push(j) }, graph });
    expect(ok).toBe(true);
    expect(seen.map((j) => j.id)).toEqual([job.id]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('done');
  });

  test('a throwing handler fails the job', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    await runOnce({ types: ['send_email'], handlers: { send_email: async () => { throw new Error('nope'); } }, graph });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'queued', attempts: 1, lastError: 'nope' });
  });

  test('a job without a handler fails with no_handler', async () => {
    const job = await enqueue(prisma, 'send_email', payload);
    await runOnce({ types: ['send_email'], handlers: {}, graph });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).lastError).toBe('no_handler');
  });

  test('runForever drains jobs and stops on abort after the current job', async () => {
    await enqueue(prisma, 'send_email', payload);
    await enqueue(prisma, 'send_email', payload);
    const controller = new AbortController();
    let done = 0;
    const loop = runForever({
      types: ['send_email'],
      handlers: {
        send_email: async () => {
          done += 1;
          if (done === 2) controller.abort();
          await new Promise((r) => setTimeout(r, 20));
        },
      },
      graph,
      pollMs: 10,
      signal: controller.signal,
    });
    await loop;
    expect(done).toBe(2);
    const jobs = await prisma.job.findMany();
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
  });

  test('runForever wakes from an idle poll when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await runForever({ types: ['send_email'], handlers: {}, graph, pollMs: 60_000, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
