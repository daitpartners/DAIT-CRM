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

const lead = (companyName: string) =>
  prisma.lead.create({ data: { companyName, country: 'UK', leadSource: 'Website' } });

test('lead numbers start at LD-1001 and count up', async () => {
  const a = await lead('A');
  const b = await lead('B');
  expect([a.number, b.number]).toEqual(['LD-1001', 'LD-1002']);
  expect(a).toMatchObject({ leadType: 'Lead', priority: 'Medium', status: 'New', enrichmentStatus: 'Pending' });
});

test('lead numbers are not padded or truncated past six digits', async () => {
  await prisma.$executeRawUnsafe(`SELECT setval('lead_number_seq', 99999)`);
  const c = await lead('C');
  expect(c.number).toBe('LD-100000');
});
