import { describe, expect, it } from 'vitest';
import { RESEARCH_STATUSES, t as translate } from '@dait-crm/shared';
import es from '../src/locales/es.json';
import fr from '../src/locales/fr.json';
import { researchStatusText } from '../src/i18n/labels';

const en = (phrase: string) => phrase.replace(/\|[^|]*$/, '');
const tr = (dict: Record<string, string>) => (phrase: string) =>
  translate(dict, Object.hasOwn(dict, phrase) ? phrase : en(phrase));

describe('researchStatusText', () => {
  it('every research status reads in en / es / fr; "Not started" is distinct from Pending', () => {
    expect(RESEARCH_STATUSES.map((s) => researchStatusText(en, s))).toEqual([...RESEARCH_STATUSES]);
    expect(RESEARCH_STATUSES.map((s) => researchStatusText(tr(es), s))).toEqual(['Sin iniciar', 'Pendiente', 'En curso', 'Completada', 'Fallida']);
    expect(RESEARCH_STATUSES.map((s) => researchStatusText(tr(fr), s))).toEqual(['Non commencée', 'En attente', 'En cours', 'Terminée', 'Échouée']);
  });
});
