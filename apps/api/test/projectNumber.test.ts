import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Company, User } from '@prisma/client';
import { prisma } from '../src/db';
import { nextProjectNumber } from '../src/projects/number';
import { resetDb } from './helpers';
import { makeCompany, makeUser } from './factory';

let company: Company;
let manager: User;

beforeAll(async () => {
  await resetDb();
  company = await makeCompany({ country: 'India' });
  manager = await makeUser();
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

/** Creates a project numbered inside its own transaction, as the API does. */
const create = () =>
  prisma.$transaction(async (tx) => {
    const number = await nextProjectNumber(tx);
    return tx.project.create({
      data: {
        number, companyId: company.id, name: 'Website', startDate: new Date('2026-11-22T00:00:00Z'),
        currency: 'INR', managerId: manager.id, createdById: manager.id,
      },
    });
  });

test('numbers run PRJ-1, PRJ-2 and a project starts Active', async () => {
  const a = await create();
  const b = await create();
  expect([a.number, b.number]).toEqual(['PRJ-1', 'PRJ-2']);
  expect(a).toMatchObject({ status: 'Active', value: null, leadId: null, quotationId: null, completedAt: null });
});

test('concurrent creates get distinct, consecutive numbers', async () => {
  const made = await Promise.all([create(), create(), create()]);
  const numbers = made.map((p) => p.number).sort();
  expect(numbers).toEqual(['PRJ-3', 'PRJ-4', 'PRJ-5']);
});

test('numbers compare numerically, not as text (PRJ-10 after PRJ-9)', async () => {
  for (let i = 6; i <= 9; i += 1) await create();
  const ten = await create();
  expect(ten.number).toBe('PRJ-10');
  expect((await create()).number).toBe('PRJ-11');
});

test('one project per quotation; deleting a project clears links and its stakeholders', async () => {
  const q = await prisma.quotation.create({
    data: { number: 'Q-2026-001', companyId: company.id, ownerId: manager.id, quotationDate: new Date('2026-11-01'), currency: 'INR', subject: 'S' },
  });
  const contact = await prisma.contact.create({ data: { companyId: company.id, firstName: 'A', lastName: 'B' } });
  const p = await create();
  await prisma.project.update({ where: { id: p.id }, data: { quotationId: q.id, stakeholders: { create: [{ contactId: contact.id }] } } });
  await prisma.quotation.update({ where: { id: q.id }, data: { projectId: p.id } });
  const other = await create();
  await expect(prisma.project.update({ where: { id: other.id }, data: { quotationId: q.id } })).rejects.toThrow();
  await expect(prisma.projectStakeholder.create({ data: { projectId: p.id, contactId: contact.id } })).rejects.toThrow();

  await prisma.project.delete({ where: { id: p.id } });
  expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).projectId).toBeNull();
  expect(await prisma.projectStakeholder.count({ where: { projectId: p.id } })).toBe(0);
});
