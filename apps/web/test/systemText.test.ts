import { describe, expect, it } from 'vitest';
import { t as translate } from '@dait-crm/shared';
import { systemDetail, systemText } from '../src/i18n/systemText';
import type { TFn } from '../src/i18n/useT';
import es from '../src/locales/es.json';
import fr from '../src/locales/fr.json';

/** The app's t() for a dictionary (as useT: a phrase's "|context" falls back to the plain phrase). */
const tFor = (dict: Record<string, string>): TFn => (phrase, vars) =>
  translate(dict, Object.hasOwn(dict, phrase) ? phrase : phrase.replace(/\|[^|]*$/, ''), vars);
const tEs = tFor(es);
const tFr = tFor(fr);
const tEn = tFor({});

describe('stored system texts in the reader language (review #04)', () => {
  it('notifications, task titles and AI history read in Spanish; names and numbers stay as stored', () => {
    expect(systemText(tEs, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 asignado a usted');
    expect(systemText(tEs, 'Follow up · Bluefin Marine Supplies')).toBe('Seguimiento · Bluefin Marine Supplies');
    expect(systemText(tEs, 'Review new lead · Bluefin Marine Supplies')).toBe('Revisar nuevo lead · Bluefin Marine Supplies');
    expect(systemText(tEs, 'New lead LD-1005')).toBe('Nuevo lead LD-1005');
    expect(systemText(tEs, 'Website reader')).toBe('Lector de sitios web');
    expect(systemText(tEs, 'Status changed to Contacted')).toBe('Estado cambiado a Contactado');
    expect(systemText(tEs, 'Quotation accepted · Q-2026-003 · USD 15,360.00')).toBe('Presupuesto aceptado · Q-2026-003 · USD 15,360.00');
  });

  it('French too, and detail lines part by part', () => {
    expect(systemText(tFr, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 qui vous est attribué');
    expect(systemDetail(tFr, '3 sent · 1 skipped · 0 failed')).toBe('3 envoyés · 1 ignoré(s) · 0 en échec');
    expect(systemDetail(tEs, 'Convert to project?')).toBe('¿Convertir en proyecto?');
    // A part it does not know (a company name) stays as stored.
    expect(systemDetail(tEs, 'Meyer Bauhaus · from LD-1010')).toBe('Meyer Bauhaus · de LD-1010');
  });

  it('English and unknown texts are shown as stored', () => {
    expect(systemText(tEn, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 assigned to you');
    expect(systemText(tEs, 'Discovery meeting')).toBe('Discovery meeting');
    expect(systemDetail(tEs, 'Maya covers this region now')).toBe('Maya covers this region now');
  });
});
