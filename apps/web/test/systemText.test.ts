import { describe, expect, it } from 'vitest';
import { t as translate } from '@dait-crm/shared';
import { notificationDetail, notificationText, researchResult, researchText, taskTitle, timelineTitle } from '../src/i18n/systemText';
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
  it('notifications, task titles, timeline and AI history read in Spanish; names and numbers stay as stored', () => {
    expect(notificationText(tEs, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 asignado a usted');
    expect(notificationText(tEs, 'Quotation accepted · Q-2026-003 · USD 15,360.00')).toBe('Presupuesto aceptado · Q-2026-003 · USD 15,360.00');
    expect(taskTitle(tEs, 'Follow up · Bluefin Marine Supplies')).toBe('Seguimiento · Bluefin Marine Supplies');
    expect(taskTitle(tEs, 'Review new lead · Bluefin Marine Supplies')).toBe('Revisar nuevo lead · Bluefin Marine Supplies');
    expect(timelineTitle(tEs, 'Status changed to Contacted')).toBe('Estado cambiado a Contactado');
    expect(timelineTitle(tEs, 'Call · Connected')).toBe('Llamada · Contestó');
    expect(timelineTitle(tEs, 'Follow-up planned · Chase proposal')).toBe('Seguimiento planificado · Chase proposal');
    expect(researchText(tEs, 'New lead LD-1005')).toBe('Nuevo lead LD-1005');
    expect(researchText(tEs, 'Website reader')).toBe('Lector de sitios web');
    expect(researchResult(tEs, '3 suggestions · Google Places: quota exceeded')).toBe('3 sugerencias · Google Places: quota exceeded');
  });

  it('French too, and system-written detail lines part by part', () => {
    expect(notificationText(tFr, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 qui vous est attribué');
    expect(timelineTitle(tFr, 'Follow-up planned · Chase proposal')).toBe('Relance planifiée · Chase proposal');
    expect(notificationDetail(tFr, 'Mailer finished · Intro', '3 sent · 1 skipped · 0 failed')).toBe('3 envoyés · 1 ignoré(s) · 0 en échec');
    expect(notificationDetail(tEs, 'Quotation accepted · Q-1 · USD 1.00', 'Convert to project?')).toBe('¿Convertir en proyecto?');
    expect(notificationDetail(tEs, 'Project created · Website', 'Meyer Bauhaus · from LD-1010')).toBe('Meyer Bauhaus · de LD-1010');
  });

  it('what a user typed is never translated (review M-2)', () => {
    // An assigner's or transfer note in a lead notification's detail stays as typed.
    expect(notificationDetail(tEs, 'Lead LD-1013 assigned to you', 'Sunrise Pharma · Assigned to Carlos as agreed')).toBe('Sunrise Pharma · Assigned to Carlos as agreed');
    expect(notificationDetail(tEs, 'Lead transferred to you · Orbit from Maya', 'from Monday')).toBe('from Monday');
    // A user's task title that looks like a timeline title stays as typed.
    expect(taskTitle(tEs, 'Call · pricing')).toBe('Call · pricing');
    expect(taskTitle(tEs, 'Discovery meeting')).toBe('Discovery meeting');
    expect(timelineTitle(tEs, 'Call · pricing')).toBe('Call · pricing');
  });

  it('English is shown as stored', () => {
    expect(notificationText(tEn, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 assigned to you');
    expect(taskTitle(tEn, 'Follow up · Orbit')).toBe('Follow up · Orbit');
  });
});
