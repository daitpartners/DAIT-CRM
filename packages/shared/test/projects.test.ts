import { PROJECT_STATUSES, projectBadge, primaryStakeholderIds } from '../src/projects';
import { projectCreateSchema, projectFormOptionsQuerySchema, projectListQuerySchema, projectUpdateSchema } from '../src/schemas/project';

const updatedAt = '2026-11-22T10:00:00.000Z';
const valid = {
  companyId: 4, name: '  Acme · Website  ', status: 'Active', startDate: '2026-11-22',
  value: 1200.456, currency: 'INR', managerId: 2, stakeholderIds: [7, 8], description: 'Build',
};

describe('project constants', () => {
  test('statuses exactly as the prototype', () => {
    expect(PROJECT_STATUSES).toEqual(['Active', 'On hold', 'Completed', 'Cancelled']);
  });
  test('badge: Active green, Completed grey, others amber', () => {
    expect(projectBadge('Active')).toBe('b-ok');
    expect(projectBadge('Completed')).toBe('b-grey');
    expect(projectBadge('On hold')).toBe('b-warn');
    expect(projectBadge('Cancelled')).toBe('b-warn');
  });
});

describe('primaryStakeholderIds', () => {
  const contacts = [
    { id: 1, isPrimary: false, contactType: 'Other' },
    { id: 2, isPrimary: true, contactType: 'Other' },
    { id: 3, isPrimary: false, contactType: 'Decision Maker' },
    { id: 4, isPrimary: false, contactType: 'Influencer' },
  ];
  test('lead contact first, then primary or Decision Maker; non-primary others excluded', () => {
    expect(primaryStakeholderIds(contacts, 4)).toEqual([4, 2, 3]);
  });
  test('no duplicates when the lead contact is also primary', () => {
    expect(primaryStakeholderIds(contacts, 2)).toEqual([2, 3]);
    expect(primaryStakeholderIds(contacts, 3)).toEqual([3, 2]);
  });
  test('without a lead contact', () => {
    expect(primaryStakeholderIds(contacts)).toEqual([2, 3]);
    expect(primaryStakeholderIds(contacts, null)).toEqual([2, 3]);
    expect(primaryStakeholderIds([], null)).toEqual([]);
  });
});

describe('projectCreateSchema', () => {
  test('accepts a full project, trims the name, rounds value to 2 dp', () => {
    const p = projectCreateSchema.parse(valid);
    expect(p).toMatchObject({ name: 'Acme · Website', value: 1200.46, currency: 'INR', stakeholderIds: [7, 8] });
  });
  test('lead, quotation, value and description are optional (or null)', () => {
    const { value: _v, description: _d, ...rest } = valid;
    expect(projectCreateSchema.safeParse(rest).success).toBe(true);
    expect(projectCreateSchema.safeParse({ ...valid, leadId: null, quotationId: null, value: null, description: '' }).success).toBe(true);
    expect(projectCreateSchema.parse({ ...valid, description: '  ' }).description).toBeNull();
  });
  test('rejects an empty name, a bad currency, an unknown status and a negative value', () => {
    expect(projectCreateSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, name: 'x'.repeat(201) }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, currency: 'EUR' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, status: 'Done' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, value: -1 }).success).toBe(false);
  });
  test('requires the company and a real YYYY-MM-DD start date', () => {
    const { companyId: _c, ...noCompany } = valid;
    expect(projectCreateSchema.safeParse(noCompany).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, startDate: '2026-02-30' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ ...valid, startDate: '22/11/2026' }).success).toBe(false);
  });
  test('removes duplicate stakeholder ids', () => {
    expect(projectCreateSchema.parse({ ...valid, stakeholderIds: [7, 7, 8] }).stakeholderIds).toEqual([7, 8]);
  });
});

describe('projectUpdateSchema', () => {
  const { companyId: _c, ...edit } = valid;
  test('needs updatedAt and has no companyId', () => {
    expect(projectUpdateSchema.safeParse(edit).success).toBe(false);
    const p = projectUpdateSchema.parse({ ...edit, companyId: 9, updatedAt });
    expect(p).not.toHaveProperty('companyId');
    expect(p.updatedAt).toBe(updatedAt);
  });
  test('the same field rules as create', () => {
    expect(projectUpdateSchema.safeParse({ ...edit, updatedAt, name: '' }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ ...edit, updatedAt, currency: 'GBP' }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ ...edit, updatedAt, status: 'Paused' }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ ...edit, updatedAt, value: -0.01 }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ ...edit, updatedAt, leadId: null, quotationId: null }).success).toBe(true);
    // Omitted lead / quotation stay undefined (unchanged), distinct from null (cleared).
    const omitted = projectUpdateSchema.parse({ ...edit, updatedAt });
    expect(omitted.leadId).toBeUndefined();
    expect(omitted.quotationId).toBeUndefined();
  });
});

describe('project list / form-options queries', () => {
  test('list filters are optional; company coerced; status must be a project status', () => {
    expect(projectListQuerySchema.parse({})).toEqual({});
    expect(projectListQuerySchema.parse({ company: '4', status: 'On hold' })).toEqual({ company: 4, status: 'On hold' });
    expect(projectListQuerySchema.safeParse({ status: 'Done' }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ company: 'x' }).success).toBe(false);
  });
  test('form-options needs the company', () => {
    expect(projectFormOptionsQuerySchema.parse({ company: '7' })).toEqual({ company: 7 });
    expect(projectFormOptionsQuerySchema.parse({ company: '7', project: '3' })).toEqual({ company: 7, project: 3 });
    expect(projectFormOptionsQuerySchema.safeParse({}).success).toBe(false);
  });
});
