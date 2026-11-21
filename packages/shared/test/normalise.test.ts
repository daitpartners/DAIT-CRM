import { domainOf, isFreeMail, normaliseCompanyName, normalisePhone } from '../src/normalise';
test.each([
  ['https://www.Acme.co.uk/about', 'acme.co.uk'], ['acme.co.uk', 'acme.co.uk'], ['http://acme.com:8080/x', 'acme.com'],
  ['x@Acme.com', 'acme.com'], ['', null], [null, null], ['   ', null],
])('domainOf(%s) = %s', (input, out) => expect(domainOf(input)).toBe(out));
test('isFreeMail', () => { expect(isFreeMail('gmail.com')).toBe(true); expect(isFreeMail('acme.com')).toBe(false); });
test.each([
  ['Northwind Logistics Private Limited', 'northwind logistics'], ['Meyer Bauhaus GmbH', 'meyer bauhaus'],
  ['Acme, Inc.', 'acme'], ['  Zenith   Retail LLC ', 'zenith retail'],
])('normaliseCompanyName(%s)', (input, out) => expect(normaliseCompanyName(input)).toBe(out));
test.each([['+91 98220 41178', '919822041178'], ['020 6710', ''], [null, '']])('normalisePhone(%s)', (i, o) => expect(normalisePhone(i)).toBe(o));
