import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { importProspects, parseOwners, PROSPECT_BATCH } from '../src/leads/importProspects';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeUser } from './factory';

const file = fileURLToPath(new URL('./fixtures/prospects-2026-11-21.csv', import.meta.url));
const quietLog = () => {};

beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

async function seed() {
  const deepak = await makeUser({ email: 'deepak@daitpartners.com', role: 'ADMINISTRATOR' });
  const carlos = await makeUser({ email: 'carlos@daitpartners.com', role: 'SALES_REPRESENTATIVE' });
  const cotton = await makeCompany({ name: 'Cotton Patch of Kentucky', website: 'https://www.cottonpatchofky.com', country: 'United States' });
  const maple = await makeCompany({ name: 'Maple Leaf Fitness', country: 'Canada' });
  const primary = await makeContact({ companyId: cotton.id });
  await prisma.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
  const owners = parseOwners('Deepak=deepak@daitpartners.com, Carlos=Carlos@daitpartners.com');
  return { deepak, carlos, cotton, maple, primary, owners };
}

describe('importProspects (21 Nov migration)', () => {
  it('parses the owners option', () => {
    expect(parseOwners('Deepak=a@x.com,Carlos=b@x.com')).toEqual({ Deepak: 'a@x.com', Carlos: 'b@x.com' });
    expect(() => parseOwners('Deepak')).toThrow(/owners/);
  });

  it('creates prospects with mapped status, priority and owner; skips unknown companies; is idempotent', async () => {
    const { deepak, carlos, cotton, maple, primary, owners } = await seed();
    const first = await importProspects(prisma, { file, owners, dryRun: false, log: quietLog });
    expect(first).toMatchObject({ rows: 4, created: 2, alreadyImported: 0, unknownCompany: ['Ghost Company'], skippedOwner: 1 });

    const leads = await prisma.lead.findMany({ orderBy: { id: 'asc' } });
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      leadType: 'Prospect', leadSource: 'CSV Import', importBatch: PROSPECT_BATCH, companyId: cotton.id,
      companyName: 'Cotton Patch of Kentucky', country: 'United States', contactId: primary.id, status: 'New',
      priority: 'High', assignedToId: carlos.id, createdById: carlos.id, nextFollowUp: null,
      notes: "Footer social icons go to Wix's own accounts, not theirs.",
    });
    expect(leads[1]).toMatchObject({
      companyId: maple.id, country: 'Canada', contactId: null, status: 'Contacted', priority: 'Medium',
      assignedToId: deepak.id, notes: null,
    });
    // Bulk migration is quiet: no "Review new lead" tasks and no notifications.
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.leadAssignment.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', action: 'create' } })).toBe(2);

    const second = await importProspects(prisma, { file, owners, dryRun: false, log: quietLog });
    expect(second).toMatchObject({ created: 0, alreadyImported: 2, skippedOwner: 1 });
    expect(await prisma.lead.count()).toBe(2);
  });

  it('dry run writes nothing', async () => {
    const { owners } = await seed();
    const tally = await importProspects(prisma, { file, owners, dryRun: true, log: quietLog });
    expect(tally).toMatchObject({ created: 2, unknownCompany: ['Ghost Company'], dryRun: true });
    expect(await prisma.lead.count()).toBe(0);
  });

  it('fails fast on a missing or inactive owner', async () => {
    await seed();
    await makeUser({ email: 'gone@daitpartners.com', isActive: false });
    await expect(importProspects(prisma, {
      file, owners: { Deepak: 'deepak@daitpartners.com', Carlos: 'nobody@daitpartners.com' }, dryRun: false, log: quietLog,
    })).rejects.toThrow(/nobody@daitpartners.com/);
    await expect(importProspects(prisma, {
      file, owners: { Deepak: 'gone@daitpartners.com' }, dryRun: false, log: quietLog,
    })).rejects.toThrow(/gone@daitpartners.com/);
    expect(await prisma.lead.count()).toBe(0);
  });
});
