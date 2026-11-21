import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useSaveTemplate, type EmailTemplate, type TemplateInput, type TemplateLanguage } from '../../api/templates';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/** What the editor opens with: an existing template, or a draft (blank, or read from an uploaded .oft). */
export type TemplateDraft = Partial<EmailTemplate> & Pick<TemplateInput, 'name' | 'subject' | 'body' | 'language'>;

export const LANGUAGE_NAMES: Record<TemplateLanguage, string> = { en: 'English', es: 'Español', fr: 'Français' };

/** Prototype template editor: Name, Language, Subject, Body, merge-field help. "Write a template" / "Edit template". */
export function TemplateModal({ draft, onClose }: { draft: TemplateDraft; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const save = useSaveTemplate();
  const [v, setV] = useState({ name: draft.name, language: draft.language, subject: draft.subject, body: draft.body });
  const [error, setError] = useState<string | null>(null);
  const editing = draft.id !== undefined;

  function submit() {
    if (!v.name.trim()) return setError(t('Give the template a name'));
    if (!v.subject.trim()) return setError(t('Enter a subject'));
    const body = editing
      ? { ...v, updatedAt: draft.updatedAt }
      : { ...v, sourceType: draft.sourceType ?? 'manual', fileName: draft.fileName ?? null, fileSize: draft.fileSize ?? null };
    save.mutate(
      { id: draft.id, body },
      {
        onSuccess: () => {
          toast(editing ? t('Template saved') : t('Template added'));
          onClose();
        },
        onError: (err) => setError(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
      },
    );
  }

  return (
    <Modal
      title={editing ? t('Edit template') : t('Write a template')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={submit}>
            {t('Save')}
          </button>
        </>
      }
    >
      {draft.sourceType === 'oft' && draft.fileName ? (
        <div className="note info">{t('Read from {file}. You can tidy the text or add merge fields before saving.', { file: draft.fileName })}</div>
      ) : null}
      <div className="grid2">
        <div>
          <label className="lbl" htmlFor="tpl-name">
            {t('Name')}
          </label>
          <input id="tpl-name" className="in" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div>
          <label className="lbl" htmlFor="tpl-lang">
            {t('Language')}
          </label>
          <select id="tpl-lang" className="in" value={v.language} onChange={(e) => setV({ ...v, language: e.target.value as TemplateLanguage })}>
            {(Object.keys(LANGUAGE_NAMES) as TemplateLanguage[]).map((k) => (
              <option key={k} value={k}>
                {LANGUAGE_NAMES[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="tpl-subject">
            {t('Subject')}
          </label>
          <input id="tpl-subject" className="in" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
        </div>
        <div className="span2">
          <label className="lbl" htmlFor="tpl-body">
            {t('Body')}
          </label>
          <textarea id="tpl-body" className="in" rows={9} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
        </div>
      </div>
      <div className="dim tpl-help">{t('Merge fields: {first_name} {company} {me} {quote_no} {lead_id}')}</div>
      {error ? (
        <div className="note warn" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
