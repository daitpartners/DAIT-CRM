import { describe, expect, it } from 'vitest';
import { t as translate } from '@dait-crm/shared';
import { notificationDetail, notificationText, researchResult, researchText, taskTitle, timelineBody, timelineTitle } from '../src/i18n/systemText';
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

  it('a failed send notification keeps the subject as written; an empty one reads (no subject) in each language (web-mail release 3)', () => {
    expect(notificationText(tEs, 'Your email "Propuesta · Q4" could not be sent')).toBe('No se pudo enviar su correo "Propuesta · Q4"');
    expect(notificationText(tFr, 'Your email "Proposal" could not be sent')).toBe('Votre e-mail « Proposal » n’a pas pu être envoyé');
    expect(notificationText(tEs, 'Your email "(no subject)" could not be sent')).toBe('No se pudo enviar su correo "(sin asunto)"');
    expect(notificationText(tFr, 'Your email "(no subject)" could not be sent')).toBe('Votre e-mail « (sans objet) » n’a pas pu être envoyé');
    expect(notificationText(tEn, 'Your email "(no subject)" could not be sent')).toBe('Your email "(no subject)" could not be sent');
  });

  it('what a user typed is never translated (review M-2)', () => {
    // An assigner's or transfer note in a lead notification's detail stays as typed.
    expect(notificationDetail(tEs, 'Lead LD-1013 assigned to you', 'Sunrise Pharma · Assigned to Carlos as agreed')).toBe('Sunrise Pharma · Assigned to Carlos as agreed');
    expect(notificationDetail(tEs, 'Lead transferred to you · Orbit from Maya', 'from Monday')).toBe('from Monday');
    // A user's task title that looks like a timeline title stays as typed.
    expect(taskTitle(tEs, 'Call · pricing')).toBe('Call · pricing');
    expect(taskTitle(tEs, 'Discovery meeting')).toBe('Discovery meeting');
    expect(timelineTitle(tEs, 'Call · pricing')).toBe('Call · pricing');
    // A meeting or research note a user typed stays as typed, even in a system shape (review N-2).
    expect(timelineTitle(tEs, 'Lead created', 'meeting')).toBe('Lead created');
    expect(timelineTitle(tEs, 'Lead created', 'research')).toBe('Lead created');
    expect(timelineTitle(tEs, 'Meeting scheduled · Kick-off', 'meeting')).toBe('Reunión planificada · Kick-off');
    expect(timelineTitle(tEs, 'Lead created', 'created')).toBe('Lead creado');
    // Only the last part of a project's detail is the server's "from LD-…" (review N-3).
    expect(notificationDetail(tEs, 'Project created · Web', 'from Monday Ltd · from LD-1010')).toBe('from Monday Ltd · de LD-1010');
    expect(notificationDetail(tEs, 'Project created · Web', 'from Acme')).toBe('from Acme');
  });

  it('Import leads: the batch notification (singular and plural), research trigger and research timeline entries', () => {
    expect(notificationText(tEs, 'Import IMPORT-2026-11-24 · 12 leads assigned to you')).toBe('Importación IMPORT-2026-11-24 · 12 leads asignados a usted');
    expect(notificationText(tEs, 'Import IMPORT-2026-11-24-2 · 1 lead assigned to you')).toBe('Importación IMPORT-2026-11-24-2 · 1 lead asignado a usted');
    expect(notificationText(tFr, 'Import IMPORT-2026-11-24 · 3 prospects assigned to you')).toBe('Import IMPORT-2026-11-24 · 3 prospects qui vous sont attribués');
    expect(notificationText(tFr, 'Import IMPORT-2026-11-24 · 1 prospect assigned to you')).toBe('Import IMPORT-2026-11-24 · 1 prospect qui vous est attribué');
    expect(researchText(tEs, 'Import IMPORT-2026-11-24')).toBe('Importación IMPORT-2026-11-24');
    expect(timelineTitle(tEs, 'Research found (not verified)', 'ai')).toBe('Encontrado por la investigación (sin verificar)');
    expect(timelineTitle(tFr, 'Accepted from research', 'ai')).toBe('Accepté depuis la recherche');
    const body = 'Email: info@x.com · https://x.com/contact · 90%\nDesignation: CEO · https://x.com/team · 85%';
    expect(timelineBody(tEs, 'Research found (not verified)', body)).toBe('Correo electrónico: info@x.com · https://x.com/contact · 90%\nCargo: CEO · https://x.com/team · 85%');
    expect(timelineBody(tFr, 'Accepted from research', 'Country: Spain · https://x.es · 90%')).toBe('Pays: Spain · https://x.es · 90%');
    // Any other body (typed by a user) is shown as stored.
    expect(timelineBody(tEs, 'Call · Connected', 'Email: a · b · 1%')).toBe('Email: a · b · 1%');
  });

  it('English is shown as stored', () => {
    expect(notificationText(tEn, 'Lead LD-1013 assigned to you')).toBe('Lead LD-1013 assigned to you');
    expect(taskTitle(tEn, 'Follow up · Orbit')).toBe('Follow up · Orbit');
  });
});
