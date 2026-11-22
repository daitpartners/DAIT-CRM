import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPANY_SETTINGS_DEFAULTS } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeUser, signIn } from './factory';

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

const req = (method: 'GET' | 'PUT', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE';
async function as(role: RoleKey): Promise<{ user: User; cookie: string }> {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const body = {
  legalName: 'DAIT Partners LLP', addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'],
  email: 'Billing@DaitPartners.com', gstin: ' 07aaafd1234a1z5 ', taxInr: 18, taxUsd: 0, taxCad: 5, defaultNotes: 'Terms',
};

describe('Settings → Company details', () => {
  it('401 signed out; 403 for anyone but an Administrator', async () => {
    expect((await req('GET', '/api/settings/company')).statusCode).toBe(401);
    for (const role of ['MANAGER', 'SALES_REPRESENTATIVE'] as const) {
      const u = await as(role);
      expect((await req('GET', '/api/settings/company', u.cookie)).statusCode).toBe(403);
      expect((await req('PUT', '/api/settings/company', u.cookie, body)).statusCode).toBe(403);
    }
    expect(await prisma.companySettings.count()).toBe(0);
  });

  it('GET falls back to the seeded defaults when the row is missing', async () => {
    const admin = await as('ADMINISTRATOR');
    const res = await req('GET', '/api/settings/company', admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ...COMPANY_SETTINGS_DEFAULTS, addressLines: [...COMPANY_SETTINGS_DEFAULTS.addressLines] });
  });

  it('PUT saves (upserts row 1), normalises email and GSTIN, audits; GET returns it', async () => {
    const admin = await as('ADMINISTRATOR');
    const res = await req('PUT', '/api/settings/company', admin.cookie, body);
    expect(res.statusCode, res.body).toBe(200);
    const expected = { ...body, email: 'billing@daitpartners.com', gstin: '07AAAFD1234A1Z5' };
    expect(res.json()).toMatchObject(expected);
    expect((await req('GET', '/api/settings/company', admin.cookie)).json()).toMatchObject(expected);
    const again = await req('PUT', '/api/settings/company', admin.cookie, { ...body, gstin: '', taxInr: 12 });
    expect(again.json()).toMatchObject({ gstin: null, taxInr: 12 });
    expect(await prisma.companySettings.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'company_settings', entityId: '1' } })).toBe(2);
  });

  it('400 on invalid input', async () => {
    const admin = await as('ADMINISTRATOR');
    expect((await req('PUT', '/api/settings/company', admin.cookie, { ...body, gstin: 'short' })).statusCode).toBe(400);
    expect((await req('PUT', '/api/settings/company', admin.cookie, { ...body, taxInr: 101 })).statusCode).toBe(400);
    expect((await req('PUT', '/api/settings/company', admin.cookie, { ...body, email: 'nope' })).statusCode).toBe(400);
  });
});
