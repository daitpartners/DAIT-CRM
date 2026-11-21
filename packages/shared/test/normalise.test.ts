import { FREE_MAIL_DOMAINS, domainOf, isFreeMail, normaliseCompanyName, normalisePhone } from '../src/normalise';
test.each([
  ['https://www.Acme.co.uk/about', 'acme.co.uk'], ['acme.co.uk', 'acme.co.uk'], ['http://acme.com:8080/x', 'acme.com'],
  ['x@Acme.com', 'acme.com'], ['', null], [null, null], ['   ', null],
])('domainOf(%s) = %s', (input, out) => expect(domainOf(input)).toBe(out));
test('isFreeMail', () => { expect(isFreeMail('gmail.com')).toBe(true); expect(isFreeMail('acme.com')).toBe(false); });
test.each([
  ['Northwind Logistics Private Limited', 'northwind logistics'], ['Meyer Bauhaus GmbH', 'meyer bauhaus'],
  ['Acme, Inc.', 'acme'], ['  Zenith   Retail LLC ', 'zenith retail'],
])('normaliseCompanyName(%s)', (input, out) => expect(normaliseCompanyName(input)).toBe(out));
test('normaliseCompanyName of only legal suffixes is empty (callers treat as no key)', () => {
  expect(normaliseCompanyName('Company Group Ltd')).toBe('');
});
test('FREE_MAIL_DOMAINS is exactly the five consumer providers', () => {
  expect([...FREE_MAIL_DOMAINS].sort()).toEqual(['gmail.com', 'hotmail.com', 'icloud.com', 'outlook.com', 'yahoo.com']);
});
test.each([['+91 98220 41178', '9822041178'], ['98220 41178', '9822041178'], ['020 6710', ''], [null, '']])('normalisePhone(%s)', (i, o) => expect(normalisePhone(i)).toBe(o));
