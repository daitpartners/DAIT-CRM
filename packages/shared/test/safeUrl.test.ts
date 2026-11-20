import { safeUrl } from '../src/safeUrl';
test.each([
  ['https://a.com/x', 'https://a.com/x'], ['http://a.com', 'http://a.com'], ['mailto:x@a.com', 'mailto:x@a.com'],
  ['tel:+441234', 'tel:+441234'], ['  example.com ', 'https://example.com'], ['javascript:alert(1)', null],
  ['data:text/html,x', null], ['', null], [null, null],
])('safeUrl(%j) -> %j', (i, o) => expect(safeUrl(i as any)).toBe(o));
