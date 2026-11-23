import { describe, expect, it } from 'vitest';
import { t as translate } from '@dait-crm/shared';
import type { TFn } from '../src/i18n/useT';
import { quoteHistoryText } from '../src/i18n/labels';
import es from '../src/locales/es.json';
import fr from '../src/locales/fr.json';

// As useT: a phrase's "|context" is dropped when the dictionary has no entry for it.
const tOf = (dict: Record<string, string>): TFn => (phrase, vars) => translate(dict, Object.hasOwn(dict, phrase) ? phrase : phrase.replace(/\|[^|]*$/, ''), vars);
const tEn = tOf({});
const tEs = tOf(es as Record<string, string>);
const tFr = tOf(fr as Record<string, string>);

describe('quotation history lines in the reader’s language (stored in English)', () => {
  const lines = [
    'Draft created by Arjun Mehta', 'Draft created by Arjun Mehta · copy of Q-2026-004', 'Revision 2 opened for editing',
    'Revision 2 discarded (unsent changes)', 'Sent · rev 1 · emailed as PDF to Ana Ruiz', 'Sent again · rev 1 · emailed as PDF to Ana Ruiz',
    'Negotiating · by Neha Kapoor', 'Accepted · by Neha Kapoor', 'Rejected · by Neha Kapoor', 'Expired · valid until 2026-12-01',
    'Send failed', 'Send failed · may not have been sent — check Sent Items before sending again',
    'Emailed, but the send could not be recorded — check the status and lead before sending again',
    'Linked to project PRJ-3', 'Converted to project PRJ-3', 'Unlinked from project PRJ-3',
  ];

  it('English reads as stored', () => {
    for (const text of lines) expect(quoteHistoryText(tEn, text).full).toBe(text);
  });

  it('Spanish and French translate every line and keep names and numbers', () => {
    for (const tr of [tEs, tFr]) {
      for (const text of lines) {
        const out = quoteHistoryText(tr, text).full;
        expect(out, text).not.toBe(text);
        for (const keep of text.match(/Arjun Mehta|Neha Kapoor|Ana Ruiz|Q-2026-004|PRJ-3|2026-12-01/g) ?? []) expect(out).toContain(keep);
      }
    }
    expect(quoteHistoryText(tEs, 'Accepted · by Neha Kapoor')).toEqual({ status: 'Accepted', rest: 'por Neha Kapoor', full: `${tEs('Accepted|quote')} · por Neha Kapoor` });
  });

  it("Expired shows the valid-until date in the user's date format", () => {
    const day = (ymd: string) => `«${ymd.split('-').reverse().join('/')}»`;
    expect(quoteHistoryText(tEn, 'Expired · valid until 2026-12-01', day).rest).toBe('valid until «01/12/2026»');
    expect(quoteHistoryText(tEs, 'Expired · valid until 2026-12-01', day).full).toContain('«01/12/2026»');
    expect(quoteHistoryText(tFr, 'Expired · valid until 2026-12-01', day).full).toContain('«01/12/2026»');
  });

  it('an unknown line is shown as stored', () => {
    expect(quoteHistoryText(tEs, 'Something new')).toEqual({ status: null, rest: 'Something new', full: 'Something new' });
  });
});
