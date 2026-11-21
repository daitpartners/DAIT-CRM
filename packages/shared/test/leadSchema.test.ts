import {
  LeadBulk, LeadCreate, LeadListQuery, LeadStatusChange, LeadTransfer, LeadUpdate, LogCall, SwitchContact,
} from '../src/schemas/lead';
import { TaskCreate, TaskListQuery, TaskUpdate } from '../src/schemas/task';
import { CLOSED_STATUSES, isClosedStatus, LEAD_TYPES, PRIORITIES, TASK_ORIGINS, ACTIVITY_TYPES } from '../src/leads';

const base = { companyName: 'Acme', country: 'United Kingdom', leadSource: 'Website' };
const updatedAt = '2026-11-21T10:00:00.000Z';

describe('lead constants', () => {
  test('closed statuses and isClosedStatus', () => {
    expect(CLOSED_STATUSES).toEqual(['Won', 'Lost', 'Not Relevant']);
    expect(isClosedStatus('Lost')).toBe(true);
    expect(isClosedStatus('New')).toBe(false);
  });
  test('enumerations', () => {
    expect(LEAD_TYPES).toEqual(['Lead', 'Prospect']);
    expect(PRIORITIES).toEqual(['High', 'Medium', 'Low']);
    expect(TASK_ORIGINS).toEqual(['follow_up', 'new_assignment', 'transfer', 'manual', 'quotation']);
    expect(ACTIVITY_TYPES).toContain('call');
    expect(ACTIVITY_TYPES).toHaveLength(11);
  });
});

describe('LeadCreate', () => {
  test('requires companyName, country and leadSource', () => {
    expect(LeadCreate.safeParse(base).success).toBe(true);
    for (const k of ['companyName', 'country', 'leadSource'] as const) {
      const { [k]: _omit, ...rest } = base;
      expect(LeadCreate.safeParse(rest).success).toBe(false);
    }
    expect(LeadCreate.safeParse({ ...base, companyName: '  ' }).success).toBe(false);
    expect(LeadCreate.safeParse({ ...base, companyName: 'x'.repeat(201) }).success).toBe(false);
  });
  test('defaults leadType, priority, status and createCompany', () => {
    const v = LeadCreate.parse(base);
    expect(v.leadType).toBe('Lead');
    expect(v.priority).toBe('Medium');
    expect(v.status).toBe('New');
    expect(v.createCompany).toBe(true);
  });
  test('rejects an impossible nextFollowUp date and accepts a real one or null', () => {
    expect(LeadCreate.safeParse({ ...base, nextFollowUp: '2026-13-01' }).success).toBe(false);
    expect(LeadCreate.safeParse({ ...base, nextFollowUp: '2026-02-30' }).success).toBe(false);
    expect(LeadCreate.safeParse({ ...base, nextFollowUp: '21/11/2026' }).success).toBe(false);
    expect(LeadCreate.parse({ ...base, nextFollowUp: '2026-11-30' }).nextFollowUp).toBe('2026-11-30');
    expect(LeadCreate.parse({ ...base, nextFollowUp: null }).nextFollowUp).toBeNull();
  });
  test('rejects a javascript: website and unknown leadType/priority', () => {
    expect(LeadCreate.safeParse({ ...base, website: 'javascript:alert(1)' }).success).toBe(false);
    expect(LeadCreate.safeParse({ ...base, leadType: 'Client' }).success).toBe(false);
    expect(LeadCreate.safeParse({ ...base, priority: 'Urgent' }).success).toBe(false);
  });
  test('accepts assignedToId null and notes up to 5000', () => {
    expect(LeadCreate.parse({ ...base, assignedToId: null }).assignedToId).toBeNull();
    expect(LeadCreate.safeParse({ ...base, notes: 'x'.repeat(5001) }).success).toBe(false);
  });
});

describe('LeadUpdate', () => {
  test('requires updatedAt; all fields optional', () => {
    expect(LeadUpdate.safeParse({ priority: 'High' }).success).toBe(false);
    expect(LeadUpdate.parse({ updatedAt }).updatedAt).toBe(updatedAt);
  });
  test('does not inject create defaults', () => {
    const v = LeadUpdate.parse({ updatedAt });
    expect(v.priority).toBeUndefined();
    expect(v.leadType).toBeUndefined();
  });
});

describe('LeadStatusChange', () => {
  test('accepts a status with a reason', () => {
    expect(LeadStatusChange.safeParse({ status: 'Lost', reason: 'Budget', updatedAt }).success).toBe(true);
  });
  test('requires updatedAt', () => {
    expect(LeadStatusChange.safeParse({ status: 'Lost' }).success).toBe(false);
  });
});

describe('LeadTransfer', () => {
  test('rejects an empty note when toUserId is set', () => {
    expect(LeadTransfer.safeParse({ toUserId: 5, note: '' }).success).toBe(false);
    expect(LeadTransfer.safeParse({ toUserId: 5, note: '   ' }).success).toBe(false);
  });
  test('accepts a note; note may be omitted (claim — enforced by the route)', () => {
    expect(LeadTransfer.safeParse({ toUserId: 5, note: 'Over to you' }).success).toBe(true);
    expect(LeadTransfer.safeParse({ toUserId: 5 }).success).toBe(true);
    expect(LeadTransfer.safeParse({ toUserId: null, note: 'Unassign' }).success).toBe(true);
    expect(LeadTransfer.safeParse({ toUserId: 5, note: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('LogCall', () => {
  test('requires a known outcome and updatedAt', () => {
    expect(LogCall.safeParse({ outcome: 'Connected', updatedAt }).success).toBe(true);
    expect(LogCall.safeParse({ outcome: 'Maybe', updatedAt }).success).toBe(false);
    expect(LogCall.safeParse({ outcome: 'Connected' }).success).toBe(false);
  });
  test('bounds minutes', () => {
    expect(LogCall.safeParse({ outcome: 'Connected', minutes: 601, updatedAt }).success).toBe(false);
    expect(LogCall.safeParse({ outcome: 'Connected', minutes: 0, updatedAt }).success).toBe(true);
  });
});

describe('LeadListQuery', () => {
  test('parses query strings', () => {
    const v = LeadListQuery.parse({ tab: 'mine', assignedTo: '7', from: '2026-11-01', sort: 'nextFollowUp' });
    expect(v.assignedTo).toBe(7);
    expect(v.page).toBe(1);
    expect(LeadListQuery.parse({ assignedTo: 'none' }).assignedTo).toBe('none');
  });
  test('rejects unknown tab, sort and bad dates', () => {
    expect(LeadListQuery.safeParse({ tab: 'won' }).success).toBe(false);
    expect(LeadListQuery.safeParse({ sort: 'secret' }).success).toBe(false);
    expect(LeadListQuery.safeParse({ to: '2026-13-01' }).success).toBe(false);
  });
});

describe('LeadBulk and SwitchContact', () => {
  test('bulk ids 1–100 and known action', () => {
    expect(LeadBulk.safeParse({ ids: [], action: 'archive' }).success).toBe(false);
    expect(LeadBulk.safeParse({ ids: Array.from({ length: 101 }, (_, i) => i + 1), action: 'archive' }).success).toBe(false);
    expect(LeadBulk.safeParse({ ids: [1], action: 'delete' }).success).toBe(false);
    expect(LeadBulk.safeParse({ ids: [1, 2], action: 'assign', toUserId: 3, note: 'n' }).success).toBe(true);
  });
  test('switch contact accepts null', () => {
    expect(SwitchContact.safeParse({ contactId: null, updatedAt }).success).toBe(true);
    expect(SwitchContact.safeParse({ contactId: 4 }).success).toBe(false);
  });
});

describe('tasks', () => {
  test('TaskListQuery defaults tab to today', () => {
    expect(TaskListQuery.parse({}).tab).toBe('today');
    expect(TaskListQuery.parse({ assignedTo: 'all' }).assignedTo).toBe('all');
    expect(TaskListQuery.parse({ assignedTo: '3' }).assignedTo).toBe(3);
  });
  test('TaskCreate requires title, dueDate and assignee', () => {
    expect(TaskCreate.safeParse({ title: 'Call back', dueDate: '2026-11-22', assignedToId: 1 }).success).toBe(true);
    expect(TaskCreate.safeParse({ title: '', dueDate: '2026-11-22', assignedToId: 1 }).success).toBe(false);
    expect(TaskCreate.safeParse({ title: 'x', dueDate: '2026-13-01', assignedToId: 1 }).success).toBe(false);
  });
  test('TaskUpdate requires updatedAt', () => {
    expect(TaskUpdate.safeParse({ isDone: true }).success).toBe(false);
    expect(TaskUpdate.safeParse({ isDone: true, updatedAt }).success).toBe(true);
  });
});
