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
test('isFreeMail knows provider families on any country suffix, and national ISPs', () => {
  for (const d of [
    'hotmail.es', 'yahoo.es', 'outlook.es', 'hotmail.fr', 'live.com.mx', 'yahoo.com.mx', 'outlook.com.br', 'gmx.fr',
    'aol.fr', 'msn.es', 'yandex.ua', 'protonmail.ch', 'googlemail.de', 'terra.com.mx', 'terra.es',
    'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'neuf.fr', 'telefonica.net', 'movistar.es',
    'prodigy.net.mx', 'bigpond.com', 't-online.de', 'mail.ru', 'web.de', 'libero.it', 'mail.hotmail.es',
  ]) expect(isFreeMail(d), d).toBe(true);
  for (const d of ['acme.es', 'live.acme.com', 'hotmailer.com', 'orange.com', 'yahooligans-tours.es', 'terrazas.mx']) {
    expect(isFreeMail(d), d).toBe(false);
  }
});
test.each([
  ['Acme S.L.', 'acme'], ['Acme SL', 'acme'], ['Acme S. A.', 'acme'], ['Construcciones Ibéricas S.A. de C.V.', 'construcciones ibericas'],
  ['Société Générale', 'societe generale'], ['Societe Generale SAS', 'societe generale'], ['Dupont SARL', 'dupont'],
  ['Rossi S.r.l.', 'rossi'], ['Müller AG', 'muller'], ['Van Dijk B.V.', 'van dijk'], ['Acme Corp.', 'acme'],
  ['Acme Pvt. Ltd.', 'acme'], ['A.Smith Trading', 'a smith trading'], ['J. Booth & Sons', 'j booth sons'],
  ['Banco de España', 'banco de espana'], ['Meridian Textiles Limited', 'meridian textiles'],
])('normaliseCompanyName folds accents and es/fr legal forms: %s', (input, out) => expect(normaliseCompanyName(input)).toBe(out));
