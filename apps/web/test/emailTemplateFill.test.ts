import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../src/lib/mergeFields';

const ctx = { firstName: 'Priya', company: 'Northwind', me: 'Maya Pillai', leadNumber: 'LD-1004' };

describe('fillTemplate', () => {
  it('replaces the prototype merge fields; {quote_no} is empty until quotations exist', () => {
    expect(fillTemplate('Hi {first_name} at {company}, {me} ({lead_id}) {quote_no}', ctx)).toBe('Hi Priya at Northwind, Maya Pillai (LD-1004) ');
  });
  it('leaves unknown placeholders as typed', () => {
    expect(fillTemplate('Dear {title} {first_name}', ctx)).toBe('Dear {title} Priya');
  });
});
