import { test, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db';
import { resetDb } from './helpers';

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

test('company numbers start at CO-0001', async () => {
  const c = await prisma.company.create({ data: { name: 'A', nameNormalised: 'a', country: 'UK' } });
  expect(c.number).toBe('CO-0001');
});

test('company numbers keep growing past CO-9999 instead of truncating', async () => {
  await prisma.$executeRawUnsafe(`SELECT setval('company_number_seq', 9998)`);
  const a = await prisma.company.create({ data: { name: 'B', nameNormalised: 'b', country: 'UK' } });
  const b = await prisma.company.create({ data: { name: 'C', nameNormalised: 'c', country: 'UK' } });
  expect([a.number, b.number]).toEqual(['CO-9999', 'CO-10000']);
});
