import { test, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db';
import { resetDb, seedLookups } from './helpers';

beforeAll(async () => {
  await resetDb();
  await seedLookups();
});
afterAll(async () => {
  await prisma.$disconnect();
});

test('lead_status lookups are seeded in order and no users exist', async () => {
  expect(await prisma.lookupValue.count({ where: { group: 'lead_status' } })).toBe(10);
  const first = await prisma.lookupValue.findFirst({ where: { group: 'lead_status' }, orderBy: { sortOrder: 'asc' } });
  expect(first?.value).toBe('New');
  expect(await prisma.user.count()).toBe(0);
});

test('seedLookups is idempotent', async () => {
  const before = await prisma.lookupValue.count();
  await seedLookups();
  expect(await prisma.lookupValue.count()).toBe(before);
});
