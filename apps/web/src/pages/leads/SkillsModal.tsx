import { useState } from 'react';
import type { LeadFull } from '../../api/leads';
import { useUpdateContactProfile } from '../../api/contacts';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ApiError } from '../../api/client';

type Contact = NonNullable<LeadFull['contact']>;

/** "a, b ,, c" → ["a", "b", "c"], duplicates (any case) dropped. */
export function splitList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const v = part.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

/** Skills & languages card's "Edit": two comma-separated lists, saved on the contact (PATCH /contacts/:id). */
export function SkillsModal({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const save = useUpdateContactProfile();
  const [skills, setSkills] = useState((contact.skills ?? []).join(', '));
  const [languages, setLanguages] = useState((contact.languages ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const s = splitList(skills);
    const l = splitList(languages);
    if (s.length > 40 || s.some((x) => x.length > 60)) return setError(t('Up to 40 skills, each up to 60 characters'));
    if (l.length > 20 || l.some((x) => x.length > 60)) return setError(t('Up to 20 languages, each up to 60 characters'));
    save.mutate(
      { id: contact.id, updatedAt: contact.updatedAt, profile: { skills: s, languages: l } },
      {
        onSuccess: () => {
          toast(t('Profile saved'));
          onClose();
        },
        onError: (err) => setError(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
      },
    );
  }

  return (
    <Modal
      title={t('Skills & languages · {name}', { name: contact.name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="skills-form" className="btn primary" disabled={save.isPending}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="skills-form"
        noValidate
        className="grid2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="span2">
          <label className="lbl" htmlFor="sk-skills">
            {t('Skills')}
          </label>
          <input id="sk-skills" className="in" value={skills} onChange={(e) => setSkills(e.target.value)} aria-describedby="sk-hint" />
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="sk-languages">
            {t('Languages')}
          </label>
          <input id="sk-languages" className="in" value={languages} onChange={(e) => setLanguages(e.target.value)} aria-describedby="sk-hint" />
        </div>
        <div id="sk-hint" className="span2 dim">
          {t('Separate with commas.')}
        </div>
        {error ? (
          <div className="span2 note warn" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
