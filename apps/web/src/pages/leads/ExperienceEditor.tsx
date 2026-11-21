import type { ExperienceEntry } from '@dait-crm/shared';
import { useT } from '../../i18n/useT';

/** One editable role; every field is the text as typed ('' = empty). */
export type XpRow = { title: string; company: string; from: string; to: string; description: string };

export const blankXpRow: XpRow = { title: '', company: '', from: '', to: '', description: '' };

const filled = (r: XpRow) => Object.values(r).some((v) => v.trim() !== '');

export function toXpRows(experience: ExperienceEntry[]): XpRow[] {
  return experience.map((e) => ({ ...e, to: e.to ?? '', description: e.description ?? '' }));
}

/**
 * The rows as API entries: blank rows dropped, a role with no end is current, current role first then newest
 * start first (as Edit profile sorts them). `null` when a filled row lacks a job title, a company or a start.
 */
export function toExperience(rows: XpRow[]): ExperienceEntry[] | null {
  const out: ExperienceEntry[] = rows.filter(filled).map((r) => ({
    title: r.title.trim(), company: r.company.trim(), from: r.from.trim(), to: r.to.trim() || null,
    description: r.description.trim() || null,
  }));
  if (out.some((e) => !e.title || !e.company || !e.from)) return null;
  return out.sort((a, b) => (!a.to && b.to ? -1 : a.to && !b.to ? 1 : b.from.localeCompare(a.from)));
}

type Props = {
  rows: XpRow[];
  onRows: (rows: XpRow[]) => void;
  /** Shown for a lead without a contact: the person the roles belong to. */
  name?: { first: string; last: string; onFirst: (v: string) => void; onLast: (v: string) => void };
  disabled?: boolean;
  /** Replaces the inputs with this note (e.g. a lead without a company). */
  note?: string;
};

/** The Experience section of Edit lead details (same row layout and limits as Edit profile). */
export function ExperienceEditor({ rows, onRows, name, disabled, note }: Props) {
  const t = useT();
  const set = (i: number, k: keyof XpRow, v: string) => onRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset className="span2 bare xp-edit" disabled={disabled}>
      <legend className="lbl">{t('Experience')}</legend>
      {note ? (
        <div className="note info">{note}</div>
      ) : (
        <>
          {name ? (
            <div className="grid2">
              <div className="dim span2">{t('This lead has no contact person yet. Name the person these roles belong to; they are added to the company and linked to this lead.')}</div>
              <div>
                <label className="lbl" htmlFor="xp-first">
                  {t('First name')}
                </label>
                <input id="xp-first" className="in" value={name.first} onChange={(e) => name.onFirst(e.target.value)} />
              </div>
              <div>
                <label className="lbl" htmlFor="xp-last">
                  {t('Last name')}
                </label>
                <input id="xp-last" className="in" value={name.last} onChange={(e) => name.onLast(e.target.value)} />
              </div>
            </div>
          ) : null}
          {rows.map((r, i) => (
            <div key={i} className="xprow">
              <input className="in" aria-label={t('Job title')} placeholder={t('Job title')} value={r.title} onChange={(e) => set(i, 'title', e.target.value)} />
              <input className="in" aria-label={t('Company')} placeholder={t('Company')} value={r.company} onChange={(e) => set(i, 'company', e.target.value)} />
              <input className="in" aria-label={t('From year')} placeholder={t('From')} value={r.from} onChange={(e) => set(i, 'from', e.target.value)} />
              <input
                className="in"
                aria-label={t('To year, blank if current')}
                placeholder={t('To · blank = current')}
                value={r.to}
                onChange={(e) => set(i, 'to', e.target.value)}
              />
              <button type="button" className="btn xs" aria-label={t('Remove this role')} title={t('Remove this role')} onClick={() => onRows(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
              <input
                className="in xp-desc"
                aria-label={t('Description')}
                placeholder={t('Description (optional)')}
                value={r.description}
                onChange={(e) => set(i, 'description', e.target.value)}
              />
            </div>
          ))}
          <button type="button" className="btn xs" disabled={rows.length >= 20} onClick={() => onRows([...rows, { ...blankXpRow }])}>
            {t('+ Add role')}
          </button>
        </>
      )}
    </fieldset>
  );
}
