import { describe, expect, it } from 'vitest';
import { escapeHtml, fillTemplate, fillTemplateHtml } from '../src/mergeFields';

const ctx = { firstName: 'Priya', company: 'Northwind', me: 'Maya Pillai', leadNumber: 'LD-1004' };

describe('fillTemplateHtml (formatted templates)', () => {
  it('fills the same merge fields as fillTemplate', () => {
    expect(fillTemplateHtml('<p>Hi <b>{first_name}</b> at {company}, {me} ({lead_id}) {quote_no}</p>', ctx)).toBe(
      '<p>Hi <b>Priya</b> at Northwind, Maya Pillai (LD-1004) </p>',
    );
    expect(fillTemplateHtml('<p>Dear {title}</p>', ctx)).toBe('<p>Dear {title}</p>');
  });

  it('HTML-escapes the values, so a company name cannot add markup', () => {
    const evil = { ...ctx, company: '<img src=x onerror=alert(1)> & "Sons"', firstName: "O'Brien" };
    const out = fillTemplateHtml('<p title="{company}">Hi {first_name} at {company}</p>', evil);
    expect(out).toBe(
      '<p title="&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Sons&quot;">Hi O&#39;Brien at &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Sons&quot;</p>',
    );
    expect(out).not.toContain('<img');
    // The plain-text rules are unchanged.
    expect(fillTemplate('{company}', evil)).toBe(evil.company);
  });

  it('escapeHtml escapes the five special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
