import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { seedSampleUsers } from '../src/seed/lookups';
import { seedSampleCompanies } from '../src/seed/companies';
import { resetDb, seedLookups } from './helpers';

beforeEach(async () => {
  await resetDb();
  await seedLookups();
  await seedSampleUsers(prisma);
});

describe('seedSampleCompanies', () => {
  it('seedSampleCompanies is idempotent and sets exactly one primary per company', async () => {
    await seedSampleCompanies(prisma);
    await seedSampleCompanies(prisma);

    // prototype/js/data.js has eleven companies (CO-0211 ... CO-0322), ten contacts, four locations.
    expect(await prisma.company.count()).toBe(11);
    expect(await prisma.contact.count()).toBe(10);
    expect(await prisma.companyLocation.count()).toBe(4);

    const withContacts = await prisma.company.findMany({ where: { contacts: { some: {} } }, include: { contacts: true } });
    expect(withContacts).toHaveLength(8);
    for (const c of withContacts) expect(c.contacts.filter((ct) => ct.isPrimary)).toHaveLength(1);

    const maya = await prisma.user.findUniqueOrThrow({ where: { email: 'maya.pillai@daitpartners.com' } });
    const northwind = await prisma.company.findUniqueOrThrow({ where: { number: 'CO-0318' }, include: { contacts: true, locations: true } });
    expect(northwind).toMatchObject({
      name: 'Northwind Logistics',
      domain: 'northwindlogistics.in',
      nameNormalised: 'northwind logistics',
      createdById: maya.id,
      businessVerticals: ['FMCG', 'Pharma', 'E-commerce'],
      keyBrands: 'NorthCold, NorthMile',
    });
    expect(northwind.contacts.find((c) => c.isPrimary)?.businessEmail).toBe('priya.raman@northwindlogistics.in');
    expect(northwind.locations.map((l) => l.name).sort()).toEqual(['Bhiwandi warehouse', 'Headquarters']);
    const sameer = northwind.contacts.find((c) => c.firstName === 'Sameer');
    expect(sameer).toMatchObject({ phoneNormalised: '2067102214', mobileNormalised: null });

    const helix = await prisma.company.findUniqueOrThrow({ where: { number: 'CO-0320' } });
    expect(helix.revenueCurrency).toBe('AED');
    const kestrel = await prisma.company.findUniqueOrThrow({ where: { number: 'CO-0322' } });
    expect(kestrel.domain).toBeNull();

    const next = await prisma.company.create({ data: { name: 'Fresh Co', nameNormalised: 'fresh co', country: 'India' } });
    expect(Number(next.number.slice(3))).toBeGreaterThan(322);
  });
});
