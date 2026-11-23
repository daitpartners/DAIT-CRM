import type { Lead, Prisma, User } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { LeadCreate, normalisePhone, roleLabel } from '@dait-crm/shared';
import { prisma } from '../src/db';
import type { AuthUser } from '../src/plugins/auth';
import {
  RuleError, applyStatusChange, createLeadWithCompany, recordAssignment, syncFollowUpTask,
} from '../src/leads/service';
import { todayIn } from '../src/leads/dates';
import { leadDetail, leadDetailInclude, leadSummary, leadSummaryInclude, taskInclude, taskRow } from '../src/leads/serialize';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeLead, makeUser } from './factory';

beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const authUser = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);
const reload = (id: number) => prisma.lead.findUniqueOrThrow({ where: { id } });
const status = (lead: Lead, to: string, by: number | null, opts?: { reason?: string; sourceTitle?: string }) =>
  tx((t) => applyStatusChange(t, lead, to, { userId: by }, opts));
const ruleError = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(RuleError);
  return (e as RuleError).code;
};

describe('applyStatusChange', () => {
  it('won flags company client and writes one converted activity', async () => {
    const rep = await makeUser();
    const company = await makeCompany();
    const lead = await makeLead({ companyId: company.id, status: 'Contacted', assignedToId: rep.id });
    const after = await status(lead, 'Won', rep.id);
    expect(after).toMatchObject({ status: 'Won', convertedTo: 'client' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).isClient).toBe(true);
    const converted = await prisma.leadActivity.findMany({ where: { leadId: lead.id, title: 'Converted to client' } });
    expect(converted).toHaveLength(1);
    expect(converted[0].body).toBe(`Previous status Contacted. Company ${company.number} flagged as Client.`);
    const st = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'status' } });
    expect(st).toMatchObject({ title: 'Status changed to Won', statusFrom: 'Contacted', statusTo: 'Won', byUserId: rep.id });
    // Unchanged status is a no-op.
    await status(after, 'Won', rep.id);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id } })).toBe(2);
  });

  it('won via log call equals won via status', async () => {
    const rep = await makeUser();
    const summary = async (lead: Lead) => {
      const l = await reload(lead.id);
      const c = await prisma.company.findUniqueOrThrow({ where: { id: lead.companyId! } });
      return {
        status: l.status, convertedTo: l.convertedTo, nextFollowUp: l.nextFollowUp, isClient: c.isClient,
        activities: await prisma.leadActivity.count({ where: { leadId: l.id } }),
        converted: await prisma.leadActivity.count({ where: { leadId: l.id, title: 'Converted to client' } }),
        notes: await prisma.leadActivity.count({ where: { leadId: l.id, activityType: 'note' } }),
        openTasks: await prisma.task.count({ where: { leadId: l.id, isDone: false } }),
        closedTasks: await prisma.task.count({ where: { leadId: l.id, isDone: true } }),
      };
    };
    const setUp = async () => {
      const lead = await makeLead({ status: 'Interested', assignedToId: rep.id, nextFollowUp: day('2026-12-01') });
      await tx((t) => syncFollowUpTask(t, lead));
      return lead;
    };
    const a = await setUp();
    const b = await setUp();
    await status(a, 'Won', rep.id);
    await status(b, 'Won', rep.id, { sourceTitle: 'Log call' });
    expect(await summary(b)).toEqual(await summary(a));
    const body = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: b.id, activityType: 'status' } });
    expect(body.body).toBe('Log call');
  });

  it('closing clears follow-up and closes open tasks with a note', async () => {
    const rep = await makeUser();
    const lead = await makeLead({ assignedToId: rep.id, nextFollowUp: day('2026-12-01') });
    await tx((t) => syncFollowUpTask(t, lead));
    await prisma.task.create({ data: { leadId: lead.id, title: 'Call back', dueDate: day('2026-12-02'), assignedToId: rep.id, origin: 'manual' } });
    const after = await status(lead, 'Lost', rep.id, { reason: 'Went with a competitor' });
    expect(after.nextFollowUp).toBeNull();
    expect(after.convertedTo).toBeNull();
    const tasks = await prisma.task.findMany({ where: { leadId: lead.id } });
    expect(tasks).toHaveLength(2);
    for (const t of tasks) expect(t).toMatchObject({ isDone: true, closedReason: 'Lead closed as Lost' });
    expect(tasks.every((t) => t.doneAt !== null)).toBe(true);
    const note = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'note' } });
    expect(note).toMatchObject({ title: '2 open task(s) closed', byUserId: null });
    const st = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'status' } });
    expect(st.body).toBe('Went with a competitor');
  });

  it('lost without reason is refused', async () => {
    const lead = await makeLead();
    expect(await ruleError(status(lead, 'Lost', null))).toBe('reason_required');
    expect(await ruleError(status(lead, 'Not Relevant', null, { reason: '   ' }))).toBe('reason_required');
    expect((await reload(lead.id)).status).toBe('New');
  });

  it('inactive status value is refused', async () => {
    await prisma.lookupValue.update({ where: { group_value: { group: 'lead_status', value: 'Qualified' } }, data: { isActive: false } });
    const lead = await makeLead();
    expect(await ruleError(status(lead, 'Qualified', null))).toBe('invalid_status');
    expect(await ruleError(status(lead, 'Bogus', null))).toBe('invalid_status');
    expect(await prisma.leadActivity.count()).toBe(0);
  });
});

describe('syncFollowUpTask', () => {
  it('follow-up task is upserted not duplicated', async () => {
    const rep = await makeUser();
    const lead = await makeLead({ companyName: 'Acme', assignedToId: rep.id });
    for (const d of ['2026-12-01', '2026-12-05', '2026-12-09']) {
      const l = await prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUp: day(d) } });
      await tx((t) => syncFollowUpTask(t, l));
    }
    const tasks = await prisma.task.findMany({ where: { leadId: lead.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Follow up · Acme', origin: 'follow_up', isDone: false, assignedToId: rep.id });
    expect(ymd(tasks[0].dueDate)).toBe('2026-12-09');
  });

  it('clearing follow-up removes its task', async () => {
    const rep = await makeUser();
    const lead = await makeLead({ assignedToId: rep.id, nextFollowUp: day('2026-12-01') });
    await tx((t) => syncFollowUpTask(t, lead));
    await prisma.task.create({ data: { leadId: lead.id, title: 'Manual', dueDate: day('2026-12-02'), assignedToId: rep.id, origin: 'manual' } });
    const cleared = await prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUp: null } });
    await tx((t) => syncFollowUpTask(t, cleared));
    const tasks = await prisma.task.findMany({ where: { leadId: lead.id } });
    expect(tasks.map((t) => t.origin)).toEqual(['manual']);
  });
});

describe('recordAssignment', () => {
  it('recordAssignment moves open tasks and notifies', async () => {
    const [from, to, manager] = [await makeUser(), await makeUser(), await makeUser({ role: 'MANAGER' })];
    const lead = await makeLead({ companyName: 'Acme', assignedToId: from.id, nextFollowUp: day('2026-12-01') });
    await tx((t) => syncFollowUpTask(t, lead));
    const done = await prisma.task.create({
      data: { leadId: lead.id, title: 'Old', dueDate: day('2026-11-01'), assignedToId: from.id, origin: 'manual', isDone: true },
    });
    const after = await tx((t) => recordAssignment(t, lead, to.id, { userId: manager.id, note: 'Covering leave' }));
    expect(after.assignedToId).toBe(to.id);
    const row = await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ fromUserId: from.id, toUserId: to.id, byUserId: manager.id, note: 'Covering leave', ruleId: null });
    const open = await prisma.task.findMany({ where: { leadId: lead.id, isDone: false } });
    expect(open).toHaveLength(1);
    expect(open[0].assignedToId).toBe(to.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.id } })).assignedToId).toBe(from.id);
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(act).toMatchObject({ activityType: 'transfer', byUserId: manager.id, body: 'Covering leave' });
    const notes = await prisma.notification.findMany({ where: { userId: to.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].link).toBe(`/leads/${lead.id}`);
    expect(await prisma.notification.count({ where: { userId: { not: to.id } } })).toBe(0);
  });

  it('refuses an inactive receiver', async () => {
    const gone = await makeUser({ isActive: false });
    const lead = await makeLead();
    expect(await ruleError(tx((t) => recordAssignment(t, lead, gone.id, { userId: null })))).toBe('unknown_user');
    expect(await prisma.leadAssignment.count()).toBe(0);
  });

  it('unassigning leaves open tasks with their owner', async () => {
    const rep = await makeUser();
    const lead = await makeLead({ assignedToId: rep.id, nextFollowUp: day('2026-12-01') });
    await tx((t) => syncFollowUpTask(t, lead));
    const after = await tx((t) => recordAssignment(t, lead, null, { userId: null, note: 'Back to pool' }));
    expect(after.assignedToId).toBeNull();
    expect((await prisma.task.findFirstOrThrow({ where: { leadId: lead.id } })).assignedToId).toBe(rep.id);
    expect(await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } })).toMatchObject({ fromUserId: rep.id, toUserId: null });
    expect((await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id } })).activityType).toBe('assign');
  });
});

describe('createLeadWithCompany', () => {
  const input = (over: Record<string, unknown> = {}) =>
    LeadCreate.parse({ companyName: 'Acme Widgets', country: 'United Kingdom', leadSource: 'Manual Entry', ...over });
  const create = (fn: (t: Prisma.TransactionClient) => ReturnType<typeof createLeadWithCompany>) => tx(fn).then((r) => r.lead);

  it('createLeadWithCompany links on domain match', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const company = await makeCompany({ name: 'Acme Ltd', website: 'https://acme.co.uk' });
    const created = await tx((t) =>
      createLeadWithCompany(t, input({ website: 'https://www.acme.co.uk/contact', assignedToId: admin.id }), authUser(admin)));
    expect(created).toMatchObject({ createdCompanyId: null, createdContactId: null });
    const lead = created.lead;
    expect(lead.companyId).toBe(company.id);
    expect(lead.number).toMatch(/^LD-\d+$/);
    expect(lead).toMatchObject({ enrichmentStatus: 'Pending', createdById: admin.id, assignedToId: admin.id, status: 'New' });
    expect(await prisma.company.count()).toBe(1);
    const acts = await prisma.leadActivity.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
    expect(acts.map((a) => a.activityType)).toContain('created');
    expect(acts.find((a) => a.activityType === 'created')!.title).toBe('Lead created');
    const review = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'new_assignment' } });
    expect(review).toMatchObject({ title: 'Review new lead · Acme Widgets', assignedToId: admin.id });
    expect(ymd(review.dueDate)).toBe(todayIn(admin.timezone));
    expect(await prisma.leadAssignment.count({ where: { leadId: lead.id, byUserId: admin.id, toUserId: admin.id } })).toBe(1);
  });

  it('creates company and primary contact when nothing matches', async () => {
    const rep = await makeUser();
    const created = await tx((t) =>
      createLeadWithCompany(
        t,
        { ...input({ businessEmail: 'Jane@NewCo.example', phone: '+44 20 7946 0000', city: 'London', nextFollowUp: '2026-12-03', assignedToId: rep.id }),
          contactFirstName: 'Jane', contactLastName: 'Doe' },
        authUser(rep),
      ));
    const lead = created.lead;
    expect(created.createdCompanyId).toBe(lead.companyId);
    expect(created.createdContactId).toBe(lead.contactId);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: lead.companyId! } });
    expect(company).toMatchObject({
      name: 'Acme Widgets', nameNormalised: 'acme widgets', domain: 'newco.example', country: 'United Kingdom',
      city: 'London', createdById: rep.id,
    });
    const contact = await prisma.contact.findFirstOrThrow({ where: { companyId: company.id } });
    expect(contact).toMatchObject({ firstName: 'Jane', lastName: 'Doe', isPrimary: true, phoneNormalised: normalisePhone('+44 20 7946 0000') });
    expect(lead.contactId).toBe(contact.id);
    const fu = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'follow_up' } });
    expect(ymd(fu.dueDate)).toBe('2026-12-03');
    // No name → no contact, but the company is still created.
    const other = await create((t) =>
      createLeadWithCompany(t, input({ companyName: 'Nameless', country: 'India', businessEmail: 'info@nameless.example' }), authUser(rep)));
    expect(other.companyId).not.toBeNull();
    expect(other.contactId).toBeNull();
    expect(await prisma.contact.count({ where: { companyId: other.companyId! } })).toBe(0);
  });

  it('name+country match leaves company null', async () => {
    const rep = await makeUser();
    const existing = await makeCompany({ name: 'Acme Widgets', country: 'United Kingdom' });
    const created = await tx((t) =>
      createLeadWithCompany(t, { ...input({ phone: '+44 20 7946 0000' }), contactFirstName: 'Jane' }, authUser(rep)));
    expect(created).toMatchObject({ createdCompanyId: null, createdContactId: null });
    expect(created.lead).toMatchObject({ companyId: null, contactId: null, companyName: 'Acme Widgets' });
    // No duplicate company or contact was made; the existing one is untouched.
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.contact.count()).toBe(0);
    expect((await prisma.company.findFirstOrThrow()).id).toBe(existing.id);
  });

  it('uses allocation rule when unassigned', async () => {
    const [admin, rep] = [await makeUser({ role: 'ADMINISTRATOR' }), await makeUser()];
    const rule = await prisma.allocationRule.create({ data: { name: 'India', matchCountries: ['India'], assignTo: rep.id, priority: 1 } });
    const lead = await create((t) => createLeadWithCompany(t, input({ country: 'India' }), authUser(admin)));
    expect(lead.assignedToId).toBe(rep.id);
    expect(await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } }))
      .toMatchObject({ fromUserId: null, toUserId: rep.id, byUserId: null, ruleId: rule.id });
    expect(await prisma.notification.count({ where: { userId: rep.id } })).toBe(1);
    // No rule for the country → stays unassigned, no assignment row.
    const none = await create((t) => createLeadWithCompany(t, input({ companyName: 'Elsewhere', country: 'France' }), authUser(admin)));
    expect(none.assignedToId).toBeNull();
    expect(await prisma.leadAssignment.count({ where: { leadId: none.id } })).toBe(0);
  });

  it('linkCompanyId must be visible', async () => {
    const [rep, admin] = [await makeUser(), await makeUser({ role: 'ADMINISTRATOR' })];
    const hidden = await makeCompany({ createdById: admin.id });
    await expect(tx((t) => createLeadWithCompany(t, input({ linkCompanyId: hidden.id }), authUser(rep)))).rejects.toThrow('not_found');
  });
});

describe('dates and serializers', () => {
  it('todayIn uses the timezone', () => {
    const now = new Date('2026-11-21T23:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-11-21');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-11-22');
    expect(todayIn('America/New_York', now)).toBe('2026-11-21');
    expect(todayIn('Not/AZone', now)).toBe('2026-11-21');
  });

  it('flags overdue and today against the given day', async () => {
    const rep = await makeUser();
    const lead = await makeLead({ assignedToId: rep.id, nextFollowUp: day('2026-11-20') });
    await prisma.task.create({ data: { leadId: lead.id, title: 'A', dueDate: day('2026-11-20'), assignedToId: rep.id, origin: 'manual' } });
    await prisma.task.create({ data: { leadId: lead.id, title: 'B', dueDate: day('2026-11-21'), assignedToId: rep.id, origin: 'manual' } });
    const tasks = await prisma.task.findMany({ include: taskInclude, orderBy: { id: 'asc' } });
    expect(tasks.map((t) => taskRow(t, '2026-11-21'))).toMatchObject([
      { title: 'A', dueDate: '2026-11-20', isOverdue: true, isToday: false, lead: { id: lead.id, number: lead.number } },
      { title: 'B', dueDate: '2026-11-21', isOverdue: false, isToday: true },
    ]);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: leadSummaryInclude });
    expect(leadSummary(row, '2026-11-21')).toMatchObject({ nextFollowUp: '2026-11-20', isOverdue: true, assignedTo: { id: rep.id } });
    expect(leadSummary(row, '2026-11-20').isOverdue).toBe(false);
    const detail = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: leadDetailInclude });
    expect(leadDetail(detail, '2026-11-21').company).toMatchObject({ contactCount: 0, openLeadCount: 1 });
  });

  it("carries the company's AI research status, summary and confidence for the lead page AI line", async () => {
    const lead = await makeLead({});
    await prisma.company.update({ where: { id: lead.companyId! }, data: { aiResearchStatus: 'Completed', aiSummary: 'Freight forwarder.', aiConfidence: 'High' } });
    const detail = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: leadDetailInclude });
    expect(leadDetail(detail, '2026-11-21').company).toMatchObject({ aiResearchStatus: 'Completed', aiSummary: 'Freight forwarder.', aiConfidence: 'High' });
  });
});
