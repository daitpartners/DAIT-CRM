import { safeUrl } from '../src/safeUrl';
test.each([
  ['https://a.com/x', 'https://a.com/x'], ['http://a.com', 'http://a.com'], ['mailto:x@a.com', 'mailto:x@a.com'],
  ['tel:+441234', 'tel:+441234'], ['  example.com ', 'https://example.com'], ['javascript:alert(1)', null],
  ['data:text/html,x', null], ['tel:5551234', 'tel:5551234'], ['localhost:3000', 'https://localhost:3000'], ['HTTPS://A.com', 'HTTPS://A.com'], ['', null], [null, null],
])('safeUrl(%j) -> %j', (i, o) => expect(safeUrl(i as any)).toBe(o));
