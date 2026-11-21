import { afterAll, beforeEach, expect, test } from 'vitest';
import { prisma } from '../src/db';
import { findCompanyMatches, findContactMatches } from '../src/companies/match';
import { resetDb } from './helpers';
import { makeCompany, makeContact } from './factory';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

test('findCompanyMatches returns the auto hit on domain', async () => {
  const nw = await makeCompany({ name: 'Northwind Logistics', website: 'https://northwindlogistics.in' });
  await makeCompany({ name: 'Unrelated Traders', website: 'unrelated.in' });
  const r = await findCompanyMatches(prisma, { website: 'www.NorthwindLogistics.in/contact' });
  expect(r.auto).toMatchObject({ id: nw.id, number: nw.number, domain: 'northwindlogistics.in' });
  expect(r.review).toEqual([]);
});

test('findCompanyMatches returns a name+country review hit when only the name is given', async () => {
  const nw = await makeCompany({ name: 'Northwind Logistics Pvt Ltd', country: 'India' });
  await makeCompany({ name: 'Northwind Logistics GmbH', country: 'Germany' });
  const r = await findCompanyMatches(prisma, { name: 'Northwind Logistics', country: 'India' });
  expect(r.auto).toBeNull();
  expect(r.review).toEqual([{ candidate: expect.objectContaining({ id: nw.id }), how: 'name_country' }]);
});

test('findCompanyMatches finds legal name case-insensitively and honours excludeId', async () => {
  const nw = await makeCompany({ name: 'Northwind', legalName: 'Northwind Logistics Private Limited' });
  const r = await findCompanyMatches(prisma, { legalName: 'NORTHWIND LOGISTICS PRIVATE LIMITED' });
  expect(r.review).toEqual([{ candidate: expect.objectContaining({ id: nw.id }), how: 'legal_name' }]);
  expect((await findCompanyMatches(prisma, { legalName: 'Northwind Logistics Private Limited', excludeId: nw.id })).review).toEqual([]);
});

test('findCompanyMatches with no usable key returns nothing without querying everything', async () => {
  await makeCompany({ name: 'Company Ltd', businessEmail: 'x@gmail.com' });
  expect(await findCompanyMatches(prisma, { name: 'Group Ltd', businessEmail: 'y@gmail.com', country: 'India' })).toEqual({ auto: null, review: [] });
});

test('findContactMatches finds by mobile when the typed phone differs only in spacing', async () => {
  const c = await makeContact({ mobile: '+91 98220 41178' });
  await makeContact({ mobile: '+91 90000 11111' });
  const r = await findContactMatches(prisma, { phone: '9822041178' });
  expect(r.auto).toBeNull();
  expect(r.review).toEqual([{ candidate: expect.objectContaining({ id: c.id }), how: 'phone' }]);
});

test('findContactMatches auto-matches on business email and finds name within company', async () => {
  const co = await makeCompany();
  const c = await makeContact({ companyId: co.id, firstName: 'Asha', lastName: 'Kulkarni', businessEmail: 'asha@northwind.in' });
  expect((await findContactMatches(prisma, { businessEmail: 'ASHA@northwind.in' })).auto?.id).toBe(c.id);
  const r = await findContactMatches(prisma, { firstName: 'asha', lastName: 'kulkarni', companyId: co.id });
  expect(r.review).toEqual([{ candidate: expect.objectContaining({ id: c.id }), how: 'name_company' }]);
  expect((await findContactMatches(prisma, { firstName: 'Asha', companyId: co.id + 999 })).review).toEqual([]);
});
