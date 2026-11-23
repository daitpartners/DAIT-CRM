import { describe, expect, it } from 'vitest';
import { IMPORT_FIELDS, importColumnLabel } from '@dait-crm/shared';
import { classifyColumns, findHeaderRow, matchHeader, sniffColumn } from '../src/imports/columns';
import { matchCountry } from '../src/imports/countries';
import { evaluateRow, isNotALead } from '../src/imports/stage';

const KNOWN = ['India', 'United Kingdom', 'United Arab Emirates', 'Australia', 'Germany', 'Spain', 'Canada', 'Italy', 'Nigeria', 'United States', 'Singapore'];

describe('matchHeader', () => {
  it('knows email, company and ignored columns in three languages', () => {
    expect(matchHeader('E-mail')).toEqual({ target: 'email', strength: 'strong' });
    expect(matchHeader('Correo electrónico')).toEqual({ target: 'email', strength: 'strong' });
    expect(matchHeader('Société')).toEqual({ target: 'companyName', strength: 'strong' });
    expect(matchHeader('Firma')).toEqual({ target: 'companyName', strength: 'weak' });
    expect(matchHeader('  Company Name ')).toEqual({ target: 'companyName', strength: 'strong' });
    expect(matchHeader('Nom')).toEqual({ target: 'contactName', strength: 'weak' });
    expect(matchHeader('Ref')).toBeNull();
    expect(matchHeader('')).toBeNull();
  });

  it('ignores the rows-to-fix columns, read through importColumnLabel', () => {
    for (const lang of ['en', 'es', 'fr'] as const) {
      expect(matchHeader(importColumnLabel('whatToFix', lang))).toEqual({ target: 'ignore', strength: 'strong' });
      expect(matchHeader(importColumnLabel('from', lang))).toEqual({ target: 'ignore', strength: 'strong' });
      expect(matchHeader(importColumnLabel('status', lang))).toEqual({ target: 'ignore', strength: 'strong' });
    }
  });

  it('every step-2 column label in every language maps back to its field', () => {
    for (const lang of ['en', 'es', 'fr'] as const) {
      for (const field of IMPORT_FIELDS) {
        expect(matchHeader(importColumnLabel(field, lang)), `${field} ${lang}`).toEqual({ target: field, strength: 'strong' });
      }
    }
  });
});

describe('sniffColumn', () => {
  it('recognises emails, websites, phones and countries', () => {
    expect(sniffColumn(['a@x.com', 'b@y.org', ''], KNOWN)).toBe('email');
    expect(sniffColumn(['acme.com', 'https://www.beta.co.uk/about', 'gamma.ae'], KNOWN)).toBe('website');
    expect(sniffColumn(['+971 4 555 0192', '(416) 555-0144', '971455501920'], KNOWN)).toBe('phone');
    expect(sniffColumn(['UAE', 'españa', 'India'], KNOWN)).toBe('country');
    expect(sniffColumn(['A1', 'A2'], KNOWN)).toBeNull();
    expect(sniffColumn(['', ''], KNOWN)).toBeNull();
    // Under 60 % emails.
    expect(sniffColumn(['a@x.com', 'none', 'n/a'], KNOWN)).toBeNull();
  });
});

describe('classifyColumns', () => {
  it('a strong header agreeing with its values is mapped without a question', () => {
    const { map, questions } = classifyColumns(['Company', 'E-mail'], [['Acme', 'Beta'], ['a@acme.com', 'b@beta.com']], KNOWN);
    expect(map).toEqual(['companyName', 'email']);
    expect(questions).toEqual([]);
  });

  it('"Notes" holding emails is mapped to email and asked', () => {
    const { map, questions } = classifyColumns(['Notes'], [['a@x.com', 'b@y.org', 'c@z.net', 'd@w.io']], KNOWN);
    expect(map).toEqual(['email']);
    expect(questions).toEqual([{ col: 0, header: 'Notes', guess: 'email', samples: ['a@x.com', 'b@y.org', 'c@z.net'] }]);
  });

  it('a weak header is applied and asked', () => {
    const { map, questions } = classifyColumns(['Firma'], [['Al Noor Logistics LLC', '', 'Meridian Textiles Ltd']], KNOWN);
    expect(map).toEqual(['companyName']);
    expect(questions).toEqual([{ col: 0, header: 'Firma', guess: 'companyName', samples: ['Al Noor Logistics LLC', 'Meridian Textiles Ltd'] }]);
  });

  it('a second "Phone" column gets a question; first and last names join without one', () => {
    const { map, questions } = classifyColumns(
      ['Phone', 'First name', 'Last name', 'Phone'],
      [['+971 4 555 0192'], ['Omar'], ['Haddad'], ['+971 50 555 0100']], KNOWN,
    );
    expect(map).toEqual(['phone', 'firstName', 'lastName', 'phone']);
    expect(questions).toEqual([{ col: 3, header: 'Phone', guess: 'phone', samples: ['+971 50 555 0100'] }]);
  });

  it('"Ref" with values A1, A2 is ignored with no question', () => {
    const { map, questions } = classifyColumns(['Company', 'Ref'], [['Acme', 'Beta'], ['A1', 'A2']], KNOWN);
    expect(map).toEqual(['companyName', null]);
    expect(questions).toEqual([]);
  });

  it('a column with no header but sniffable values is guessed and asked', () => {
    const { map, questions } = classifyColumns(['Column A'], [['acme.com', 'beta.org']], KNOWN);
    expect(map).toEqual(['website']);
    expect(questions).toEqual([{ col: 0, header: 'Column A', guess: 'website', samples: ['acme.com', 'beta.org'] }]);
  });
});

describe('findHeaderRow', () => {
  it('finds a header below a title row', () => {
    expect(findHeaderRow([['Expo Dubai visitors 2026'], [], ['Firma', 'Contact', 'E-mail', 'Country']])).toBe(2);
  });

  it('falls back to the first all-text row, else none', () => {
    expect(findHeaderRow([['Title'], ['Organización del stand', 'Persona responsable'], ['Acme', 'Ana']])).toBe(1);
    expect(findHeaderRow([['Total visitors', '412'], ['Countries', '23']])).toBe(-1);
  });
});

describe('matchCountry', () => {
  it('matches names, codes and local spellings to the CRM list', () => {
    expect(matchCountry('UAE', KNOWN)).toBe('United Arab Emirates');
    expect(matchCountry('españa', KNOWN)).toBe('Spain');
    expect(matchCountry('  united kingdom ', KNOWN)).toBe('United Kingdom');
    expect(matchCountry('U.K.', KNOWN)).toBe('United Kingdom');
    expect(matchCountry('USA', KNOWN)).toBe('United States');
    expect(matchCountry('DE', KNOWN)).toBe('Germany');
    expect(matchCountry('IND', KNOWN)).toBe('India');
  });

  it('never returns a country that is not in the list', () => {
    expect(matchCountry('Chile', KNOWN)).toBeNull();
    expect(matchCountry('México', KNOWN)).toBeNull();
    expect(matchCountry('México', [...KNOWN, 'Mexico'])).toBe('Mexico');
    expect(matchCountry('', KNOWN)).toBeNull();
  });
});

describe('rows', () => {
  const ctx = { knownCountries: KNOWN, match: null, notALead: false };

  it('Ready needs company, country and an email', () => {
    const r = evaluateRow({ companyName: 'Al Noor Logistics LLC', country: 'UAE', email: 'omar.h@alnoorlogistics.ae' }, ctx);
    expect(r).toEqual({
      status: 'Ready', problems: [],
      fields: { companyName: 'Al Noor Logistics LLC', country: 'United Arab Emirates', email: 'omar.h@alnoorlogistics.ae' },
    });
  });

  it('a phone without an email is Missing details with email_missing', () => {
    const r = evaluateRow({ companyName: 'Brightline Dental Clinics', country: 'Canada', phone: '+1 416 555 0144' }, ctx);
    expect(r.status).toBe('Missing details');
    expect(r.problems).toEqual([{ code: 'email_missing', field: 'email', level: 'missing' }]);
  });

  it('no email and no phone marks both; no country too', () => {
    const r = evaluateRow({ companyName: 'Northgate Retail Group', website: 'northgateretail.com' }, ctx);
    expect(r.status).toBe('Missing details');
    expect(r.problems).toEqual([
      { code: 'country_missing', field: 'country', level: 'missing' },
      { code: 'contact_missing', field: 'email', level: 'missing' },
      { code: 'contact_missing', field: 'phone', level: 'missing' },
    ]);
  });

  it('an unknown country does not block Ready but is flagged', () => {
    const r = evaluateRow({ companyName: 'Andes Foods', country: 'Chile', email: 'ventas@andesfoods.cl' }, ctx);
    expect(r.status).toBe('Ready');
    expect(r.problems).toEqual([{ code: 'country_unknown', field: 'country', level: 'questionable', value: 'Chile' }]);
  });

  it('an invalid email or website is flagged; an invalid email is not an email', () => {
    const r = evaluateRow({ companyName: 'Acme', country: 'India', email: 'sales at acme', website: 'not a site', phone: '+91 22 5555 0100' }, ctx);
    expect(r.status).toBe('Missing details');
    expect(r.problems).toEqual([
      { code: 'email_invalid', field: 'email', level: 'questionable', value: 'sales at acme' },
      { code: 'website_invalid', field: 'website', level: 'questionable', value: 'not a site' },
    ]);
  });

  it('Not a lead comes first, then Already in CRM', () => {
    expect(evaluateRow({ companyName: 'Acme' }, { ...ctx, notALead: true })).toMatchObject({ status: 'Not a lead' });
    expect(evaluateRow({ companyName: 'Acme', email: 'a@acme.com' }, { ...ctx, match: { id: 4, number: 'CO-0004' } }))
      .toMatchObject({ status: 'Already in CRM', problems: [{ code: 'already_in_crm', level: 'info', value: 'CO-0004' }] });
  });

  it('Not a lead: blank, totals, repeated header, nothing to reach', () => {
    const header = ['Firma', 'Contact', 'E-mail'];
    expect(isNotALead({}, ['', ''], header)).toBe(true);
    expect(isNotALead({ companyName: 'TOTAL VISITORS DAY 2' }, ['TOTAL VISITORS DAY 2'], header)).toBe(true);
    expect(isNotALead({ companyName: 'Grand total', email: 'x@y.com' }, ['Grand total', '', 'x@y.com'], header)).toBe(true);
    expect(isNotALead({ companyName: 'Total général' }, ['Total général'], header)).toBe(true);
    expect(isNotALead({ companyName: 'Firma', contactName: 'Contact' }, ['Firma', 'Contact', 'E-mail'], header)).toBe(true);
    expect(isNotALead({ contactName: 'Omar', city: 'Dubai' }, ['', 'Omar'], header)).toBe(true);
    expect(isNotALead({ companyName: 'Totalcare Ltd' }, ['Totalcare Ltd'], header)).toBe(false);
    expect(isNotALead({ website: 'acme.com' }, ['', '', 'acme.com'], null)).toBe(false);
  });
});
