import { FREE_MAIL_DOMAINS, SHARED_HOST_DOMAINS, domainOf, isFreeMail, isSharedHost, normaliseCompanyName, normalisePhone } from '../src/normalise';
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
test('FREE_MAIL_DOMAINS covers the common consumer providers, including Indian ones', () => {
  for (const d of ['gmail.com', 'hotmail.com', 'icloud.com', 'outlook.com', 'yahoo.com', 'yahoo.co.in', 'rediffmail.com', 'zohomail.in', 'proton.me']) {
    expect(FREE_MAIL_DOMAINS.has(d)).toBe(true);
  }
  expect(FREE_MAIL_DOMAINS.size).toBeGreaterThanOrEqual(43);
});
test('isFreeMail matches subdomains and is case-insensitive, but not lookalikes', () => {
  expect(isFreeMail('yahoo.co.in')).toBe(true);
  expect(isFreeMail('mail.yahoo.co.in')).toBe(true);
  expect(isFreeMail(' GMAIL.com ')).toBe(true);
  expect(isFreeMail('notgmail.com')).toBe(false);
  expect(isFreeMail('acme.co.in')).toBe(false);
  expect(isFreeMail('')).toBe(false);
});
test('isSharedHost covers social, builder and marketplace hosts and their subdomains', () => {
  for (const d of ['facebook.com', 'linkedin.com', 'indiamart.com', 'wixsite.com', 'acme.wixsite.com', 'acme.myshopify.com', 'sites.google.com']) {
    expect(isSharedHost(d)).toBe(true);
  }
  expect(SHARED_HOST_DOMAINS.has('justdial.com')).toBe(true);
  expect(isSharedHost('acme.co.in')).toBe(false);
  expect(isSharedHost('myfacebook.com')).toBe(false);
});
test.each([['+91 98220 41178', '9822041178'], ['98220 41178', '9822041178'], ['020 6710', ''], [null, '']])('normalisePhone(%s)', (i, o) => expect(normalisePhone(i)).toBe(o));
