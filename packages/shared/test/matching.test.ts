import { rankCompanyMatches, rankContactMatches } from '../src/matching';

const nw = { id: 1, number: 'CO-0001', name: 'Northwind Logistics', legalName: 'Northwind Logistics Private Limited', domain: 'northwindlogistics.in', country: 'India', city: 'Pune' };
test('exact domain from website auto-matches', () => expect(rankCompanyMatches({ website: 'https://www.northwindlogistics.in/x' }, [nw]).auto?.id).toBe(1));
test('exact domain from business email auto-matches', () => expect(rankCompanyMatches({ businessEmail: 'a@northwindlogistics.in' }, [nw]).auto?.id).toBe(1));
test('ignores free-mail domains', () => { const r = rankCompanyMatches({ businessEmail: 'a@gmail.com', name: 'Northwind Logistics', country: 'India' }, [nw]); expect(r.auto).toBeNull(); expect(r.review).toEqual([{ candidate: nw, how: 'name_country' }]); });
test('legal name goes to review, not auto', () => { const r = rankCompanyMatches({ legalName: 'northwind logistics private limited' }, [nw]); expect(r.auto).toBeNull(); expect(r.review[0].how).toBe('legal_name'); });
test('name + country needs the same country', () => expect(rankCompanyMatches({ name: 'Northwind Logistics Ltd', country: 'Germany' }, [nw]).review).toEqual([]));
test('excludeId drops the record being edited', () => expect(rankCompanyMatches({ website: 'northwindlogistics.in', excludeId: 1 }, [nw]).auto).toBeNull());

test('website domain wins over business-email domain', () => {
  const other = { ...nw, id: 2, number: 'CO-0002', domain: 'other.com' };
  expect(rankCompanyMatches({ website: 'other.com', businessEmail: 'a@northwindlogistics.in' }, [nw, other]).auto?.id).toBe(2);
});
test('review is ordered legal_name before name_country and de-duplicated by id', () => {
  const twin = { ...nw, id: 2, number: 'CO-0002', legalName: null, domain: null };
  const r = rankCompanyMatches({ legalName: 'Northwind Logistics Private Limited', name: 'Northwind Logistics', country: 'india' }, [twin, nw]);
  expect(r.review).toEqual([{ candidate: nw, how: 'legal_name' }, { candidate: twin, how: 'name_country' }]);
});
test('auto hit is not repeated in review', () => {
  const r = rankCompanyMatches({ website: 'northwindlogistics.in', name: 'Northwind Logistics', country: 'India' }, [nw]);
  expect(r.auto?.id).toBe(1);
  expect(r.review).toEqual([]);
});
test('a name that is only legal suffixes is no key', () => {
  const blank = { ...nw, id: 3, name: 'Company Ltd', legalName: null, domain: null };
  expect(rankCompanyMatches({ name: 'Group Pvt Ltd', country: 'India' }, [blank]).review).toEqual([]);
});

const asha = { id: 7, companyId: 1, firstName: 'Asha', lastName: 'Kulkarni', businessEmail: 'asha@northwindlogistics.in', phoneNormalised: '2067104455', mobileNormalised: '9822041178' };
test('contact: email auto, phone review, name+company review', () => {
  expect(rankContactMatches({ businessEmail: ' Asha@NorthwindLogistics.in ' }, [asha]).auto?.id).toBe(7);
  expect(rankContactMatches({ phone: '+91 98220-41178' }, [asha])).toEqual({ auto: null, review: [{ candidate: asha, how: 'phone' }] });
  expect(rankContactMatches({ firstName: 'asha', lastName: 'KULKARNI', companyId: 1 }, [asha])).toEqual({ auto: null, review: [{ candidate: asha, how: 'name_company' }] });
});
test('contact: name needs the same company, lastName optional, excludeId honoured', () => {
  expect(rankContactMatches({ firstName: 'Asha', companyId: 2 }, [asha]).review).toEqual([]);
  expect(rankContactMatches({ firstName: 'Asha', companyId: 1 }, [asha]).review).toHaveLength(1);
  expect(rankContactMatches({ firstName: 'Asha', lastName: 'Rao', companyId: 1 }, [asha]).review).toEqual([]);
  expect(rankContactMatches({ businessEmail: 'asha@northwindlogistics.in', excludeId: 7 }, [asha]).auto).toBeNull();
});
test('contact: short phone is no key', () => {
  const p = { ...asha, phoneNormalised: null, mobileNormalised: null };
  expect(rankContactMatches({ phone: '6710' }, [p]).review).toEqual([]);
});
