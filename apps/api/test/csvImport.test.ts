import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSV_MAX_ROWS } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeUser, signIn } from './factory';

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

const req = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: RoleKey): Promise<{ user: User; cookie: string }> {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const mapping = {
  columns: {
    companyName: 'Company', website: 'Website', businessEmail: 'Email', phone: null, country: 'Country', city: 'City',
    contactFirstName: 'First Name', contactLastName: 'Last Name', contactEmail: null, leadSource: null,
    priority: 'Priority', notes: 'Notes', sourceUrl: null,
  },
};
const HEADER = 'Company,Website,Email,Country,City,First Name,Last Name,Priority,Notes';

describe('CSV lead import', () => {
  it('preview suggests a mapping from headers', async () => {
    const admin = await as('ADMINISTRATOR');
    const csv = '﻿company name,WEBSITE,Business Email,country,Phone,Notes,Extra\n'
      + 'Acme,https://acme.com,info@acme.com,India,123,hi,x\n'
      + 'Beta,,,India,,,\n\n';
    const res = await req('POST', '/api/imports/leads/preview', admin.cookie, { csv });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headers).toEqual(['company name', 'WEBSITE', 'Business Email', 'country', 'Phone', 'Notes', 'Extra']);
    expect(body.rowCount).toBe(2);
    expect(body.sample).toEqual([
      ['Acme', 'https://acme.com', 'info@acme.com', 'India', '123', 'hi', 'x'],
      ['Beta', '', '', 'India', '', '', ''],
    ]);
    expect(body.suggestedMapping.columns).toMatchObject({
      companyName: 'company name', website: 'WEBSITE', businessEmail: 'Business Email', country: 'country',
      phone: 'Phone', notes: 'Notes', city: null, priority: null,
    });

    // Rights: a signed-out caller is refused.
    expect((await req('POST', '/api/imports/leads/preview', undefined, { csv })).statusCode).toBe(401);
  });

  it('csv links on domain match', async () => {
    const admin = await as('ADMINISTRATOR');
    const acme = await makeCompany({ name: 'Acme Ltd', website: 'https://acme.com', country: 'India' });
    const primary = await makeContact({ companyId: acme.id });
    await prisma.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
    const csv = `${HEADER}\nAcme Holdings,https://www.acme.com/about,,India,Pune,,,High,From the fair\n`;
    const res = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping, assignedToId: admin.user.id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.batch).toMatch(/^CSV-\d{8}-\d{4}$/);
    expect(body).toMatchObject({ created: 1, linked: 1, review: [], errors: [] });
    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      leadType: 'Prospect', companyId: acme.id, contactId: primary.id, importBatch: body.batch, leadSource: 'CSV Import',
      priority: 'High', notes: 'From the fair', city: 'Pune', assignedToId: admin.user.id, status: 'New',
    });
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', action: 'create', entityId: String(lead.id) } })).toBe(1);
  });

  it('csv reports bad rows and imports the rest', async () => {
    const admin = await as('ADMINISTRATOR');
    const csv = [
      HEADER,
      'Good One,https://goodone.com,sales@goodone.com,India,,Asha,Rao,,',
      ',https://noname.com,,India,,,,,',
      'Nowhere Co,https://nowhere.com,,Atlantis,,,,,',
      'Bad Priority,https://badprio.com,,India,,,,Urgent,',
      'Good Two,https://goodtwo.com,,United Kingdom,,,,low,',
    ].join('\n');
    const res = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(2);
    expect(body.linked).toBe(0);
    expect(body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
    expect(body.errors[1].message).toMatch(/country/i);
    const leads = await prisma.lead.findMany({ orderBy: { id: 'asc' }, include: { company: true, contact: true } });
    expect(leads.map((l) => l.companyName)).toEqual(['Good One', 'Good Two']);
    expect(leads[1].priority).toBe('Low');
    // A new company with its primary contact from the contact columns.
    expect(leads[0].company).toMatchObject({ name: 'Good One', domain: 'goodone.com', country: 'India' });
    expect(leads[0].contact).toMatchObject({ firstName: 'Asha', lastName: 'Rao', isPrimary: true });
    expect(await prisma.auditLog.count({ where: { entityType: 'company', action: 'create' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: 'contact', action: 'create' } })).toBe(1);
  });

  it('csv row with name+country review candidate is created unlinked and listed', async () => {
    const admin = await as('ADMINISTRATOR');
    const existing = await makeCompany({ name: 'Zenith Traders', website: 'https://zenith-old.com', country: 'India' });
    const csv = `${HEADER}\nZenith Traders,https://zenith-new.com,,India,,,,,\n`;
    const res = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 1, linked: 0, errors: [] });
    expect(body.review).toHaveLength(1);
    expect(body.review[0]).toMatchObject({
      row: 1, companyName: 'Zenith Traders',
      candidates: [{ id: existing.id, number: existing.number, name: 'Zenith Traders', how: 'name_country' }],
    });
    const lead = await prisma.lead.findFirstOrThrow();
    expect(body.review[0].leadId).toBe(lead.id);
    expect(lead).toMatchObject({ companyId: null, contactId: null, leadType: 'Prospect' });
    expect(await prisma.company.count()).toBe(1);
  });

  it('resolve-company links a review row', async () => {
    const admin = await as('ADMINISTRATOR');
    const existing = await makeCompany({ name: 'Zenith Traders', country: 'India' });
    const primary = await makeContact({ companyId: existing.id });
    await prisma.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
    const csv = `${HEADER}\nZenith Traders,https://zenith-new.com,,India,,,,,\nZenith Traders,https://zenith-other.com,,India,,,,,\n`;
    const imported = (await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping })).json();
    const [first, second] = imported.review.map((r: { leadId: number }) => r.leadId);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: first } });

    const stale = await req('POST', `/api/leads/${first}/resolve-company`, admin.cookie, {
      companyId: existing.id, updatedAt: new Date(0).toISOString(),
    });
    expect(stale.statusCode).toBe(409);

    const linked = await req('POST', `/api/leads/${first}/resolve-company`, admin.cookie, {
      companyId: existing.id, updatedAt: lead.updatedAt.toISOString(),
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ companyId: existing.id });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ companyId: existing.id, contactId: primary.id });
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', action: 'update', entityId: String(first) } })).toBe(1);

    // Already linked: refused.
    const again = await prisma.lead.findUniqueOrThrow({ where: { id: first } });
    const twice = await req('POST', `/api/leads/${first}/resolve-company`, admin.cookie, {
      companyId: existing.id, updatedAt: again.updatedAt.toISOString(),
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({ error: 'company_already_linked' });

    // 'create' makes a new company from the lead's details.
    const other = await prisma.lead.findUniqueOrThrow({ where: { id: second } });
    const created = await req('POST', `/api/leads/${second}/resolve-company`, admin.cookie, {
      companyId: 'create', updatedAt: other.updatedAt.toISOString(),
    });
    expect(created.statusCode).toBe(200);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: second }, include: { company: true } });
    expect(after.company).toMatchObject({ name: 'Zenith Traders', domain: 'zenith-other.com', country: 'India', createdById: admin.user.id });
    expect(after.contactId).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityType: 'company', action: 'create', entityId: String(after.companyId) } })).toBe(1);

    // A rep cannot link a company they cannot see.
    const rep = await as('SALES_REPRESENTATIVE');
    const third = await prisma.lead.create({ data: { companyName: 'Hidden', country: 'India', leadSource: 'Manual Entry', assignedToId: rep.user.id } });
    const hidden = await makeCompany({ name: 'Hidden Co' });
    const refused = await req('POST', `/api/leads/${third.id}/resolve-company`, rep.cookie, {
      companyId: hidden.id, updatedAt: third.updatedAt.toISOString(),
    });
    expect(refused.statusCode).toBe(404);
  });

  it('malformed csv returns csv_invalid', async () => {
    const admin = await as('ADMINISTRATOR');
    for (const csv of [`${HEADER}\n"Unclosed,https://x.com,,India,,,,,\n`, `${HEADER}\n`, '\n\n ']) {
      const preview = await req('POST', '/api/imports/leads/preview', admin.cookie, { csv });
      expect(preview.statusCode).toBe(400);
      expect(preview.json()).toMatchObject({ error: 'csv_invalid', message: expect.any(String) });
      const imported = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping });
      expect(imported.statusCode).toBe(400);
      expect(imported.json()).toMatchObject({ error: 'csv_invalid', message: expect.any(String) });
    }
    expect(await prisma.lead.count()).toBe(0);
  });

  it('csv over 1000 data rows returns csv_too_large', async () => {
    const admin = await as('ADMINISTRATOR');
    const rows = (n: number) => `${HEADER}\n${Array.from({ length: n }, (_, i) => `Bulk Co ${i},,,India,,,,,`).join('\n')}\n`;
    const atCap = await req('POST', '/api/imports/leads/preview', admin.cookie, { csv: rows(CSV_MAX_ROWS) });
    expect(atCap.statusCode).toBe(200);
    expect(atCap.json().rowCount).toBe(1000);
    const csv = rows(CSV_MAX_ROWS + 1);
    const preview = await req('POST', '/api/imports/leads/preview', admin.cookie, { csv });
    expect(preview.statusCode).toBe(400);
    expect(preview.json()).toEqual({ error: 'csv_too_large', rows: 1001, max: 1000 });
    const imported = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping });
    expect(imported.statusCode).toBe(400);
    expect(imported.json()).toEqual({ error: 'csv_too_large', rows: 1001, max: 1000 });
    expect(await prisma.lead.count()).toBe(0);
  });

  it('mapping with unknown header is rejected', async () => {
    const admin = await as('ADMINISTRATOR');
    const csv = `${HEADER}\nAcme,https://acme.com,,India,,,,,\n`;
    for (const [field, header] of [['companyName', 'Business'], ['notes', '__proto__'], ['phone', 'constructor']] as const) {
      const bad = { columns: { ...mapping.columns, [field]: header } };
      const res = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation', issues: [{ path: ['mapping', 'columns', field] }] });
    }
    expect(await prisma.lead.count()).toBe(0);
  });

  it('review row keeps the CSV contact in its notes', async () => {
    const admin = await as('ADMINISTRATOR');
    await makeCompany({ name: 'Zenith Traders', country: 'India' });
    const withPhone = { columns: { ...mapping.columns, phone: 'Phone', contactEmail: 'Contact Email' } };
    const csv = 'Company,Website,Email,Country,City,First Name,Last Name,Priority,Notes,Phone,Contact Email\n'
      + 'Zenith Traders,https://zenith-new.com,info@zenith-new.com,India,,Ravi,Kumar,,Met at expo,+91 98765 43210,ravi@zenith-new.com\n'
      + 'Zenith Traders,https://zenith-two.com,,India,,Mina,,,,,\n';
    const body = (await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping: withPhone })).json();
    expect(body.review).toHaveLength(2);
    const [first, second] = await prisma.lead.findMany({ orderBy: { id: 'asc' } });
    expect(first.notes).toBe('Met at expo\nCSV contact: Ravi Kumar <ravi@zenith-new.com> +91 98765 43210');
    expect(second.notes).toBe('CSV contact: Mina');
  });

  it('review row notes stay within 5000 characters after the contact note', async () => {
    const admin = await as('ADMINISTRATOR');
    await makeCompany({ name: 'Zenith Traders', country: 'India' });
    const long = 'x'.repeat(4990);
    const csv = `${HEADER}\nZenith Traders,https://zenith-new.com,,India,,Ravi,Kumar,,${long}\n`;
    const body = (await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping })).json();
    expect(body).toMatchObject({ created: 1, errors: [] });
    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead.notes).toHaveLength(5000);
    expect(lead.notes).toBe(`${long}\nCSV contact: Ravi Kumar`.slice(0, 5000));
  });

  it('import refuses an unassignable assignee and a caller without manage_leads', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser();
    const csv = `${HEADER}\nAcme,,,India,,,,,\n`;
    const res = await req('POST', '/api/imports/leads', rep.cookie, { csv, mapping, assignedToId: other.id });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'cannot_assign_hidden' });
    expect(await prisma.lead.count()).toBe(0);
    expect((await req('POST', '/api/imports/leads', undefined, { csv, mapping })).statusCode).toBe(401);
  });
});
