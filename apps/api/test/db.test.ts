import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../src/db';
import { databaseName, resetDb, seedLookups } from './helpers';
import { makeUser } from './factory';

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

test('seedLookups preserves admin edits to existing rows', async () => {
  const before = await prisma.lookupValue.count();
  await prisma.lookupValue.update({
    where: { group_value: { group: 'lead_status', value: 'New' } },
    data: { label: 'Fresh', isActive: false, sortOrder: 99 },
  });
  await seedLookups();
  const row = await prisma.lookupValue.findUniqueOrThrow({ where: { group_value: { group: 'lead_status', value: 'New' } } });
  expect(row).toMatchObject({ label: 'Fresh', isActive: false, sortOrder: 99 });
  expect(await prisma.lookupValue.count()).toBe(before);
});

test('resetDb refuses to truncate a database that is not *_unit or *_e2e', async () => {
  expect(databaseName('postgresql://u:p@localhost:5432/dait_crm_unit?schema=public')).toBe('dait_crm_unit');
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/dait_crm');
  try {
    await expect(resetDb()).rejects.toThrow(/refuses to truncate database "dait_crm"/);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('email_messages has flag_status (default notFlagged), flag_due and size_bytes (default 0)', async () => {
  const user = await makeUser();
  const m = await prisma.emailMessage.create({
    data: { userId: user.id, folder: 'inbox', status: 'received', fromAddress: 'a@b.co', subject: 's' },
  });
  expect(m).toMatchObject({ flagStatus: 'notFlagged', flagDue: null, sizeBytes: 0 });
});

test('web-mail release 3 columns: user signature, task priority and note, message schedule/quote/files', async () => {
  const user = await makeUser();
  const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(u).toMatchObject({ signatureHtml: null, signatureAuto: true });
  const t = await prisma.task.create({
    data: { title: 'x', dueDate: new Date('2026-12-01'), assignedToId: user.id, origin: 'manual' },
  });
  expect(t).toMatchObject({ priority: 'normal', note: null });
  const m = await prisma.emailMessage.create({
    data: { userId: user.id, folder: 'drafts', status: 'draft', fromAddress: 'a@b.co', subject: 's' },
  });
  expect(m).toMatchObject({ scheduledAt: null, quotedHtml: null, draftFiles: [] });
});
