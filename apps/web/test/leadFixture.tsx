import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { LeadFull } from '../src/api/leads';
import { keys, type LookupValue, type Me } from '../src/api/queries';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { ToastProvider } from '../src/components/Toast';

export const rep: Me = {
  id: 2, email: 'arjun@daitpartners.com', name: 'Arjun Mehta', role: 'Sales Representative', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'claim_leads', 'manage_companies'],
};

export const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});

export const STATUSES: LookupValue[] = [
  lookup('lead_status', 'New', 3), lookup('lead_status', 'Contacted', 4), lookup('lead_status', 'Won', 5),
  lookup('lead_status', 'Lost', 6), lookup('lead_status', 'Not Relevant', 7),
];

/** A lead with a company and a contact that has no profile fields at all. */
export function makeLead(overrides: Partial<LeadFull> = {}): LeadFull {
  return {
    id: 5, number: 'LD-1005', leadType: 'Lead', companyName: 'Meridian Textiles', companyId: 4, country: 'India', outreachLanguage: 'en' as const, city: null,
    leadSource: 'Referral', status: 'New', priority: 'Medium', assignedTo: { id: 2, name: 'Arjun Mehta' }, assignedToId: 2,
    nextFollowUp: null, isOverdue: false, archivedAt: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z',
    website: null, businessEmail: null, phone: null, sourceUrl: null, importBatch: null, notes: null, contactId: 9,
    company: {
      id: 4, number: 'CO-0245', name: 'Meridian Textiles', industry: null, city: null, country: 'India', employeeRange: null,
      isClient: false, verificationStatus: null, contactCount: 1, openLeadCount: 1, legalName: null, website: null, domain: null,
      businessCategory: null, timezone: null, aiResearchStatus: 'Not started', aiSummary: null, aiConfidence: null,
    },
    contact: {
      id: 9, companyId: 4, company: { id: 4, number: 'CO-0245', name: 'Meridian Textiles' }, firstName: 'Tom', lastName: 'Hale',
      name: 'Tom Hale', designation: null, department: null, businessEmail: null, email: null, phone: null, mobile: null,
      linkedinUrl: null, contactType: 'Other', isPrimary: false, isActive: true, headline: null, location: null, about: null,
      experience: [], education: [], skills: [], languages: [], updatedAt: '2026-11-20T10:00:00.000Z',
    },
    createdBy: null, activities: [], activityTotal: 0, callCount: 0, lastContact: null, assignments: [], tasks: [],
    ...overrides,
  };
}

export function makeClient(me: Me = rep) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.users, []);
  qc.setQueryData(keys.lookups, {
    country: [lookup('country', 'India', 1)],
    lead_source: [lookup('lead_source', 'Referral', 2)],
    lead_status: STATUSES,
  });
  return qc;
}

export function Wrap({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** YYYY-MM-DD `days` from today in the browser's local date. */
export function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
