import type { FastifyInstance } from 'fastify';
import type { Lead, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeLead, makeUser, signIn } from './factory';

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

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const stamp = (l: Lead) => l.updatedAt.toISOString();
const reload = (id: number) => prisma.lead.findUniqueOrThrow({ where: { id } });

describe('transfer', () => {
  it('transfer moves open tasks and notifies', async () => {
    const manager = await as('MANAGER');
    const [from, to] = [await makeUser({ name: 'Asha' }), await makeUser({ name: 'Ben' })];
    const lead = await makeLead({ companyName: 'Acme', assignedToId: from.id, nextFollowUp: day('2026-12-01') });
    const open = await prisma.task.create({
      data: { leadId: lead.id, title: 'Send deck', dueDate: day('2026-12-02'), assignedToId: from.id, origin: 'manual' },
    });
    const done = await prisma.task.create({
      data: { leadId: lead.id, title: 'Old', dueDate: day('2026-11-01'), assignedToId: from.id, origin: 'manual', isDone: true },
    });

    const res = await req('POST', `/api/leads/${lead.id}/transfer`, manager.cookie, { toUserId: to.id, note: 'Covering leave', updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignedTo).toEqual({ id: to.id, name: 'Ben' });

    expect((await prisma.task.findUniqueOrThrow({ where: { id: open.id } })).assignedToId).toBe(to.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.id } })).assignedToId).toBe(from.id);
    const followUp = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } });
    expect(followUp.assignedToId).toBe(to.id);

    const row = await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ fromUserId: from.id, toUserId: to.id, byUserId: manager.user.id, note: 'Covering leave' });
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'transfer' } });
    expect(act.body).toBe('Covering leave');

    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: to.id, text: 'Lead transferred to you · Acme from Asha', detail: 'Covering leave', link: `/leads/${lead.id}`,
    });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id) } });
    expect(log.userId).toBe(manager.user.id);

    // The client's copy is now stale.
    const again = await req('POST', `/api/leads/${lead.id}/transfer`, manager.cookie, { toUserId: from.id, note: 'Back', updatedAt: stamp(lead) });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'stale' });
  });

  it('transfer refuses empty note', async () => {
    const manager = await as('MANAGER');
    const [from, to] = [await makeUser(), await makeUser()];
    const lead = await makeLead({ assignedToId: from.id });
    const res = await req('POST', `/api/leads/${lead.id}/transfer`, manager.cookie, { toUserId: to.id, updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'transfer_note_required' });
    expect((await reload(lead.id)).assignedToId).toBe(from.id);
    expect(await prisma.leadAssignment.count()).toBe(0);

    // Taking it yourself needs no note.
    const self = await req('POST', `/api/leads/${lead.id}/transfer`, manager.cookie, { toUserId: manager.user.id, updatedAt: stamp(lead) });
    expect(self.statusCode).toBe(200);
    expect((await reload(lead.id)).assignedToId).toBe(manager.user.id);
    expect(await prisma.notification.count()).toBe(0);

    // Sales Representatives cannot transfer.
    const rep = await as('SALES_REPRESENTATIVE');
    const own = await makeLead({ assignedToId: rep.user.id });
    const denied = await req('POST', `/api/leads/${own.id}/transfer`, rep.cookie, { toUserId: to.id, note: 'Yours', updatedAt: stamp(own) });
    expect(denied.statusCode).toBe(403);
  });

  it('transfer refuses inactive user', async () => {
    const admin = await as('ADMINISTRATOR');
    const from = await makeUser();
    const gone = await makeUser({ isActive: false });
    const lead = await makeLead({ assignedToId: from.id });
    const res = await req('POST', `/api/leads/${lead.id}/transfer`, admin.cookie, { toUserId: gone.id, note: 'Over', updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_user' });
    expect((await reload(lead.id)).assignedToId).toBe(from.id);
    const missing = await req('POST', `/api/leads/${lead.id}/transfer`, admin.cookie, { toUserId: 999_999, note: 'Over', updatedAt: stamp(lead) });
    expect(missing.json()).toEqual({ error: 'unknown_user' });
  });
});

describe('claim', () => {
  it('rep claims an unassigned lead', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ companyName: 'Free Co', nextFollowUp: day('2026-12-01') });
    const res = await req('POST', `/api/leads/${lead.id}/claim`, rep.cookie, { updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignedTo).toEqual({ id: rep.user.id, name: rep.user.name });
    const row = await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ fromUserId: null, toUserId: rep.user.id, byUserId: rep.user.id });
    const task = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'follow_up' } });
    expect(task.assignedToId).toBe(rep.user.id);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', entityId: String(lead.id) } })).toBe(1);
  });

  it('rep cannot claim an assigned lead', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser();
    const theirs = await makeLead({ assignedToId: other.id });
    // Another rep's lead is hidden from this rep.
    expect((await req('POST', `/api/leads/${theirs.id}/claim`, rep.cookie, { updatedAt: stamp(theirs) })).statusCode).toBe(404);
    // Visible but already taken: 409.
    const mine = await makeLead({ assignedToId: rep.user.id });
    const taken = await req('POST', `/api/leads/${mine.id}/claim`, rep.cookie, { updatedAt: stamp(mine) });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'already_assigned' });
    const manager = await as('MANAGER');
    const held = await req('POST', `/api/leads/${theirs.id}/claim`, manager.cookie, { updatedAt: stamp(theirs) });
    expect(held.json()).toEqual({ error: 'already_assigned' });
    expect((await reload(theirs.id)).assignedToId).toBe(other.id);
    // Data Research Users have no claim right.
    const dru = await as('DATA_RESEARCH_USER');
    const free = await makeLead({ leadType: 'Prospect' });
    expect((await req('POST', `/api/leads/${free.id}/claim`, dru.cookie, { updatedAt: stamp(free) })).statusCode).toBe(403);
    expect(await prisma.leadAssignment.count()).toBe(0);
  });
});

describe('unassign', () => {
  it('unassign writes a row with null', async () => {
    const manager = await as('MANAGER');
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    expect((await req('POST', `/api/leads/${lead.id}/unassign`, rep.cookie, { note: 'Drop', updatedAt: stamp(lead) })).statusCode).toBe(403);
    const noNote = await req('POST', `/api/leads/${lead.id}/unassign`, manager.cookie, { updatedAt: stamp(lead) });
    expect(noNote.statusCode).toBe(400);

    const res = await req('POST', `/api/leads/${lead.id}/unassign`, manager.cookie, { note: 'Back to the pool', updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignedTo).toBeNull();
    const row = await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ fromUserId: rep.user.id, toUserId: null, byUserId: manager.user.id, note: 'Back to the pool' });
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(act).toMatchObject({ activityType: 'assign', title: 'Unassigned', body: 'Back to the pool' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id) } });
    expect(log.after).toMatchObject({ assignedToId: null });
  });
});
