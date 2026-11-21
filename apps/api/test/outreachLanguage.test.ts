import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultOutreachLanguage, parseOutreachLanguage } from '@dait-crm/shared';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
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
  for (const value of ['Mexico', 'Chile']) {
    await prisma.lookupValue.upsert({ where: { group_value: { group: 'country', value } }, create: { group: 'country', value, label: value, sortOrder: 99 }, update: {} });
  }
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const newLead = (cookie: string, extra: Record<string, unknown>) =>
  call('POST', '/api/leads', cookie, { companyName: `Co ${Math.random()}`, leadSource: 'Referral', ...extra });

describe('outreach language', () => {
  it('shared helpers: Spanish-speaking countries default to es; values parse from words', () => {
    expect(defaultOutreachLanguage('Mexico')).toBe('es');
    expect(defaultOutreachLanguage('Chile')).toBe('es');
    expect(defaultOutreachLanguage('United States')).toBe('en');
    // Accented spellings an administrator may type for the country lookup.
    expect(['México', 'Perú', 'Panamá'].map(defaultOutreachLanguage)).toEqual(['es', 'es', 'es']);
    expect(['es', 'Español', 'spanish', 'ES'].map(parseOutreachLanguage)).toEqual(['es', 'es', 'es', 'es']);
    expect(['en', 'English', 'Inglés'].map(parseOutreachLanguage)).toEqual(['en', 'en', 'en']);
    expect(parseOutreachLanguage('Klingon')).toBeNull();
  });

  it('a new lead defaults from its country, keeps an explicit choice, and a later country edit does not flip it', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const cookie = await signIn(app, admin);
    const mx = await newLead(cookie, { country: 'Mexico', assignedToId: admin.id });
    expect(mx.statusCode).toBe(201);
    expect(mx.json().outreachLanguage).toBe('es');
    const us = await newLead(cookie, { country: 'United States', assignedToId: admin.id });
    expect(us.json().outreachLanguage).toBe('en');
    const usEs = await newLead(cookie, { country: 'United States', outreachLanguage: 'es', assignedToId: admin.id });
    expect(usEs.json().outreachLanguage).toBe('es');

    const loaded = usEs.json() as { id: number; updatedAt: string };
    const moved = await call('PATCH', `/api/leads/${loaded.id}`, cookie, { country: 'India', updatedAt: loaded.updatedAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().outreachLanguage).toBe('es');
    const switched = await call('PATCH', `/api/leads/${loaded.id}`, cookie, { outreachLanguage: 'en', updatedAt: moved.json().updatedAt });
    expect(switched.json().outreachLanguage).toBe('en');

    const filtered = await call('GET', '/api/leads?language=es', cookie);
    expect(filtered.json().items.map((l: { id: number }) => l.id)).toEqual([mx.json().id]);
  });

  it('allocation: a Spanish-only rule takes Spanish leads; English leads fall through to the next rule', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const carlos = await makeUser({ role: 'ADMINISTRATOR', name: 'Carlos Torres' });
    const deepak = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
    const cookie = await signIn(app, admin);
    const r1 = await call('POST', '/api/allocation-rules', cookie, { name: 'Spanish', matchCountries: ['*'], matchLanguage: 'es', assignTo: [carlos.id], priority: 1 });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().matchLanguage).toBe('es');
    await call('POST', '/api/allocation-rules', cookie, { name: 'English US', matchCountries: ['United States'], matchLanguage: 'en', assignTo: [deepak.id], priority: 2 });

    const es = await newLead(cookie, { country: 'United States', outreachLanguage: 'es' });
    expect(es.json().assignedTo?.id).toBe(carlos.id);
    const en = await newLead(cookie, { country: 'United States' });
    expect(en.json().assignedTo?.id).toBe(deepak.id);
    const mx = await newLead(cookie, { country: 'Mexico' });
    expect(mx.json().assignedTo?.id).toBe(carlos.id);
  });

  it('CSV import reads an Outreach language column; unknown values fall back to the country default', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const cookie = await signIn(app, admin);
    const csv = 'Company,Country,Language\nAlpha SA,United States,Español\nBeta LLC,United States,\nGamma SpA,Chile,whatever\n';
    const res = await call('POST', '/api/imports/leads', cookie, {
      csv, mapping: { columns: { companyName: 'Company', country: 'Country', outreachLanguage: 'Language' } }, assignedToId: admin.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([]);
    const rows = await prisma.lead.findMany({ select: { companyName: true, outreachLanguage: true }, orderBy: { companyName: 'asc' } });
    expect(rows).toEqual([
      { companyName: 'Alpha SA', outreachLanguage: 'es' },
      { companyName: 'Beta LLC', outreachLanguage: 'en' },
      { companyName: 'Gamma SpA', outreachLanguage: 'es' },
    ]);
  });
});
