import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeLead, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/reports', headers: cookie ? { cookie } : {} });

describe('reports API', () => {
  it('401 when signed out', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('leads by source counts every non-archived lead (as the prototype), largest first; enquiries are 0 until 1D', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await makeLead({ leadSource: 'Referral', assignedToId: other.id });
    await makeLead({ leadSource: 'Referral', assignedToId: null });
    await makeLead({ leadSource: 'LinkedIn', assignedToId: rep.id });
    await makeLead({ leadSource: 'Referral', archivedAt: new Date() });

    const res = await get(await signIn(app, rep));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bySource: [
        { source: 'Referral', count: 2 },
        { source: 'LinkedIn', count: 1 },
      ],
      enquiries: { received: 0, spamBlocked: 0, leadsCreated: 0, awaitingReview: 0, matchedExisting: 0 },
    });
  });
});
