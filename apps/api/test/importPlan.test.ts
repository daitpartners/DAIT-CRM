import { describe, expect, it } from 'vitest';
import type { ResearchValue, RowFields } from '@dait-crm/shared';
import { effectiveFields, planBatch, summarisePlan, type PlanRow } from '../src/imports/plan';

const known = ['India', 'United Arab Emirates', 'Spain', 'Canada'];
const found = (value: string, confidence: number): ResearchValue => ({
  value, confidence, sourceUrl: `https://source.test/${encodeURIComponent(value)}`, sourceLabel: 'source.test',
});

let id = 0;
function row(
  fields: RowFields,
  o: { research?: Record<string, ResearchValue>; status?: string; include?: boolean; matchedCompanyId?: number | null } = {},
): PlanRow {
  id += 1;
  return {
    id, fields, research: o.research ?? {}, status: o.status ?? 'Ready', include: o.include ?? true,
    matchedCompanyId: o.matchedCompanyId ?? null,
  };
}
const plan1 = (r: PlanRow, acceptHigh = false, noContactRows: 'import' | 'leave' | null = 'import') =>
  planBatch([r], { acceptHigh, noContactRows, knownCountries: known })[0]!;

describe('effectiveFields', () => {
  it('own values always; a research value fills an empty field only when ticked and at least 80', () => {
    const r = row({ companyName: 'Own Co', city: 'Pune' }, {
      research: { city: found('Mumbai', 95), email: found('info@own.test', 90), phone: found('+91 20 1234 5678', 70) },
    });
    expect(effectiveFields(r, false)).toEqual({ fields: { companyName: 'Own Co', city: 'Pune' }, fromResearch: [] });
    expect(effectiveFields(r, true)).toEqual({
      fields: { companyName: 'Own Co', city: 'Pune', email: 'info@own.test' }, fromResearch: ['email'],
    });
  });
});

describe('planBatch', () => {
  it('an unticked research email (90) does not count for noContact; ticked it does, a 70 one does not', () => {
    const r90 = row({ companyName: 'Mail Co', country: 'India' }, { status: 'Missing details', research: { email: found('a@mail.test', 90) } });
    expect(plan1(r90, false)).toMatchObject({ action: 'import', noContact: true });
    expect(plan1(r90, true)).toMatchObject({ action: 'import', noContact: false });
    const r70 = row({ companyName: 'Mail Co', country: 'India' }, { status: 'Missing details', research: { email: found('a@mail.test', 70) } });
    expect(plan1(r70, true)).toMatchObject({ noContact: true });
  });

  it('skip reasons: not a lead, unticked (already in CRM), company, country missing, unknown country, left out', () => {
    const plans = planBatch([
      row({}, { status: 'Not a lead', include: true }),
      row({ companyName: 'Unticked', country: 'India', email: 'a@u.test' }, { include: false }),
      row({ companyName: 'Old Co', country: 'India', email: 'a@old.test' }, { status: 'Already in CRM', include: false, matchedCompanyId: 7 }),
      row({ country: 'India', email: 'a@noname.test' }, { status: 'Missing details' }),
      row({ companyName: 'No Country', email: 'a@nc.test' }, { status: 'Missing details' }),
      row({ companyName: 'Chile Co', country: 'Chile', email: 'a@cl.test' }),
      row({ companyName: 'Silent Co', country: 'India' }, { status: 'Missing details' }),
    ], { acceptHigh: false, noContactRows: 'leave', knownCountries: known });
    expect(plans.map((p) => [p.action, p.reason])).toEqual([
      ['skip', 'not_a_lead'], ['skip', 'unticked'], ['skip', 'already_in_crm'], ['skip', 'company_missing'],
      ['skip', 'country_missing'], ['skip', 'country_unknown'], ['skip', 'no_contact_left_out'],
    ]);
    const summary = summarisePlan(plans);
    expect(summary).toMatchObject({
      willImport: 0, skipped: { total: 7, alreadyInCrm: 1, notLead: 1, unticked: 1, other: 4 }, noContactRows: 1,
      unknownCountries: [{ value: 'Chile', count: 1 }],
    });
  });

  it('"import" keeps no-contact rows; null counts them but does not decide', () => {
    const r = row({ companyName: 'Silent Co', country: 'India' }, { status: 'Missing details' });
    expect(plan1(r, false, 'import')).toMatchObject({ action: 'import', noContact: true });
    expect(plan1(r, false, null)).toMatchObject({ action: 'import', noContact: true });
    expect(summarisePlan([plan1(r, false, null)]).noContactRows).toBe(1);
  });

  it('two rows with the same domain → one new company; a ticked Already in CRM row → an existing company', () => {
    const plans = planBatch([
      row({ companyName: 'Al Noor Logistics', website: 'https://alnoorlogistics.ae', country: 'United Arab Emirates', email: 'omar@alnoorlogistics.ae' }),
      row({ companyName: 'Al-Noor Logistics LLC', country: 'United Arab Emirates', email: 'sara@alnoorlogistics.ae' }),
      row({ companyName: 'Old Co', country: 'India', email: 'a@old.test' }, { status: 'Already in CRM', include: true, matchedCompanyId: 7 }),
    ], { acceptHigh: false, noContactRows: null, knownCountries: known });
    expect(plans[0]!.companyKey).toBe('d:alnoorlogistics.ae');
    expect(plans[1]!.companyKey).toBe('d:alnoorlogistics.ae');
    expect(plans[2]).toMatchObject({ action: 'import', existingCompanyId: 7 });
    expect(summarisePlan(plans)).toMatchObject({ willImport: 3, newCompanies: 1, existingCompanies: 1, skipped: { total: 0 } });
  });

  it('a country only from research: left out unless ticked (Q2), counted under "rows that still need you"', () => {
    const r = row({ companyName: 'Phone Co', phone: '+34 600 000 000' }, { status: 'Missing details', research: { country: found('Spain', 90) } });
    const unticked = plan1(r, false);
    expect(unticked).toMatchObject({ action: 'skip', reason: 'country_missing', researchOnlyCountry: true });
    expect(summarisePlan([unticked]).researchOnlyCountry).toBe(1);
    expect(plan1(r, true)).toMatchObject({ action: 'import', reason: null, researchOnlyCountry: false });
  });

  it('a phone-only row (Missing details) with a country imports, noContact false', () => {
    const r = row({ companyName: 'Phone Only', country: 'Canada', phone: '+1 416 555 0144' }, { status: 'Missing details' });
    expect(plan1(r, false, null)).toMatchObject({ action: 'import', noContact: false, reason: null });
  });

  it('the country is matched to the CRM spelling', () => {
    const r = row({ companyName: 'UAE Co', country: 'UAE', email: 'a@uae.test' });
    expect(plan1(r)).toMatchObject({ action: 'import' });
  });
});
