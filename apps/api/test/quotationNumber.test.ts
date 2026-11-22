import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Company, User } from '@prisma/client';
import { prisma } from '../src/db';
import { nextQuotationNumber } from '../src/quotations/number';
import { resetDb } from './helpers';
import { makeCompany, makeUser } from './factory';

let company: Company;
let owner: User;

beforeAll(async () => {
  await resetDb();
  company = await makeCompany({ country: 'India' });
  owner = await makeUser();
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

/** Creates a quotation numbered inside its own transaction, as the API does. */
const create = (date: string) =>
  prisma.$transaction(async (tx) => {
    const quotationDate = new Date(`${date}T00:00:00Z`);
    const number = await nextQuotationNumber(tx, quotationDate);
    return tx.quotation.create({
      data: { number, companyId: company.id, ownerId: owner.id, quotationDate, currency: 'INR', subject: 'Advisory services' },
    });
  });

test('numbers run Q-YYYY-NNN from 001 within the quotation date’s year', async () => {
  const a = await create('2026-01-05');
  const b = await create('2026-11-22');
  expect([a.number, b.number]).toEqual(['Q-2026-001', 'Q-2026-002']);
  expect(a).toMatchObject({ status: 'Draft', revision: 1, editingNewRevision: false, history: [] });
});

test('a quotation dated in another year starts that year at 001', async () => {
  const c = await create('2027-01-01');
  expect(c.number).toBe('Q-2027-001');
  const d = await create('2026-12-31');
  expect(d.number).toBe('Q-2026-003');
});

test('ten concurrent creates get ten distinct, consecutive numbers', async () => {
  const made = await Promise.all(Array.from({ length: 10 }, () => create('2026-06-15')));
  const numbers = made.map((q) => q.number).sort();
  expect(new Set(numbers).size).toBe(10);
  expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `Q-2026-${String(i + 4).padStart(3, '0')}`));
});

test('the sequence grows past 999 instead of truncating', async () => {
  await prisma.quotation.create({
    data: { number: 'Q-2028-999', companyId: company.id, ownerId: owner.id, quotationDate: new Date('2028-03-01'), currency: 'USD', subject: 'S' },
  });
  const next = await create('2028-04-01');
  expect(next.number).toBe('Q-2028-1000');
  const after = await create('2028-04-02');
  expect(after.number).toBe('Q-2028-1001');
});
