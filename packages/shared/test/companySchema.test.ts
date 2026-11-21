import { CompanyBulkStatus, CompanyCreate, CompanyListQuery, CompanyUpdate } from '../src/schemas/company';
import { ContactCreate, ContactListQuery } from '../src/schemas/contact';
import { LocationCreate } from '../src/schemas/location';
import { PagingQuery, pageArgs } from '../src/schemas/paging';

const base = { name: 'Acme', country: 'United Kingdom' };

describe('CompanyCreate', () => {
  test('rejects a javascript: website', () => {
    expect(CompanyCreate.safeParse({ ...base, website: 'javascript:alert(1)' }).success).toBe(false);
  });
  test('rejects mailto: as a website', () => {
    expect(CompanyCreate.safeParse({ ...base, website: 'mailto:x@acme.com' }).success).toBe(false);
  });
  test('accepts a bare host and adds https://', () => {
    expect(CompanyCreate.parse({ ...base, website: 'acme.com' }).website).toBe('https://acme.com');
  });
  test('turns a blank optional string into null', () => {
    expect(CompanyCreate.parse({ ...base, legalName: '  ' }).legalName).toBeNull();
  });
  test('trims optional strings', () => {
    expect(CompanyCreate.parse({ ...base, city: '  Pune ' }).city).toBe('Pune');
  });
  test('rejects yearEstablished before 1800 and in the future', () => {
    expect(CompanyCreate.safeParse({ ...base, yearEstablished: 1700 }).success).toBe(false);
    expect(CompanyCreate.safeParse({ ...base, yearEstablished: new Date().getFullYear() + 1 }).success).toBe(false);
    expect(CompanyCreate.safeParse({ ...base, yearEstablished: 1999 }).success).toBe(true);
  });
  test('requires country', () => {
    expect(CompanyCreate.safeParse({ name: 'Acme' }).success).toBe(false);
  });
  test('defaults status and multi-selects', () => {
    const c = CompanyCreate.parse(base);
    expect(c.status).toBe('Active');
    expect(c.businessVerticals).toEqual([]);
  });
  test('upper-cases a 3-letter currency and rejects others', () => {
    expect(CompanyCreate.parse({ ...base, revenueCurrency: 'gbp' }).revenueCurrency).toBe('GBP');
    expect(CompanyCreate.safeParse({ ...base, revenueCurrency: 'GBPX' }).success).toBe(false);
  });
});

describe('CompanyUpdate', () => {
  test('requires updatedAt and does not apply create defaults', () => {
    expect(CompanyUpdate.safeParse({ name: 'X' }).success).toBe(false);
    const u = CompanyUpdate.parse({ updatedAt: new Date().toISOString(), name: 'X' });
    expect(u.status).toBeUndefined();
    expect(u.businessVerticals).toBeUndefined();
  });
});

describe('ContactCreate', () => {
  test('lower-cases email and defaults contactType', () => {
    const c = ContactCreate.parse({ companyId: 1, firstName: 'Ana', lastName: 'Ruiz', businessEmail: ' Ana@Acme.COM ' });
    expect(c.businessEmail).toBe('ana@acme.com');
    expect(c.contactType).toBe('Other');
    expect(c.isPrimary).toBe(false);
  });
});

describe('LocationCreate', () => {
  test('bounds lat/lng and defaults source', () => {
    const l = { name: 'HQ', locationType: 'Headquarters', country: 'India' };
    expect(LocationCreate.parse(l).source).toBe('Manual');
    expect(LocationCreate.safeParse({ ...l, lat: 91 }).success).toBe(false);
    expect(LocationCreate.safeParse({ ...l, lng: -181 }).success).toBe(false);
  });
});

describe('PagingQuery', () => {
  test('rejects pageSize above 100 (400, not clamped)', () => {
    expect(PagingQuery.safeParse({ pageSize: '500' }).success).toBe(false);
  });
  test('defaults page 1 / size 25 and coerces strings', () => {
    expect(PagingQuery.parse({})).toMatchObject({ page: 1, pageSize: 25, dir: 'asc' });
    expect(PagingQuery.parse({ page: '3', pageSize: '10' })).toMatchObject({ page: 3, pageSize: 10 });
  });
  test('pageArgs', () => {
    expect(pageArgs({ page: 3, pageSize: 10 })).toEqual({ skip: 20, take: 10 });
  });
});

describe('CompanyListQuery', () => {
  test('whitelists sort and parses filters', () => {
    expect(CompanyListQuery.safeParse({ sort: 'nameNormalised' }).success).toBe(false);
    expect(CompanyListQuery.parse({ sort: 'updatedAt', isClient: 'true', status: 'Closed' }))
      .toMatchObject({ sort: 'updatedAt', isClient: true, status: 'Closed', page: 1 });
    expect(CompanyListQuery.safeParse({ isClient: 'yes' }).success).toBe(false);
  });
});

describe('ContactListQuery', () => {
  test('whitelists sort and coerces companyId', () => {
    expect(ContactListQuery.safeParse({ sort: 'phoneNormalised' }).success).toBe(false);
    expect(ContactListQuery.parse({ sort: 'company', companyId: '7', contactType: 'Other' }))
      .toMatchObject({ sort: 'company', companyId: 7, contactType: 'Other', page: 1 });
    expect(ContactListQuery.safeParse({ companyId: 'x' }).success).toBe(false);
  });
});

describe('CompanyBulkStatus', () => {
  test('needs ids and a known status', () => {
    expect(CompanyBulkStatus.safeParse({ ids: [], status: 'Inactive' }).success).toBe(false);
    expect(CompanyBulkStatus.safeParse({ ids: [1], status: 'Gone' }).success).toBe(false);
    expect(CompanyBulkStatus.parse({ ids: [1, 2], status: 'Inactive' })).toEqual({ ids: [1, 2], status: 'Inactive' });
  });
});
