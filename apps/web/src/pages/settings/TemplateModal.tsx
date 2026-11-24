import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useSaveTemplate, useTemplateImages, type EmailTemplate, type TemplateInput, type TemplateLanguage } from '../../api/templates';
import { AttachmentChips } from '../../components/AttachmentChips';
import { MessageEditor, type MessageValue } from '../../components/MessageEditor';
import { restoreCids, showInlineImages, uploadImages, type UploadFile } from '../../lib/templateFiles';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/**
 * What the editor opens with: an existing template, or a draft (blank, or read from an uploaded .oft, with the
 * pictures and attachments read from it in `uploads`).
 */
export type TemplateDraft = Partial<EmailTemplate> & Pick<TemplateInput, 'name' | 'subject' | 'body' | 'language'> & { uploads?: UploadFile[] };

export const LANGUAGE_NAMES: Record<TemplateLanguage, string> = { en: 'English', es: 'Español', fr: 'Français' };

/** Prototype template editor: Name, Language, Subject, Body, merge-field help. "Write a template" / "Edit template". */
export function TemplateModal({ draft, onClose }: { draft: TemplateDraft; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const save = useSaveTemplate();
  const [v, setV] = useState({ name: draft.name, language: draft.language, subject: draft.subject });
  // An uploaded .oft's files (the regular attachments can be removed before saving); a saved template's are listed.
  const [uploads, setUploads] = useState<UploadFile[]>(draft.uploads ?? []);
  // Inline pictures show in the editor as data: URLs: an upload's from its bytes, a saved template's fetched.
  const saved = useTemplateImages(draft.id !== undefined && draft.attachments && draft.updatedAt ? (draft as EmailTemplate) : null);
  const [images] = useState(() => uploadImages(draft.uploads ?? []));
  const shownImages = draft.uploads ? images : saved;
  // A formatted template (an .oft's HTML, sanitised by the server) is edited formatted; a plain one stays a textarea.
  const [body, setBody] = useState<MessageValue>({ text: draft.body, html: draft.bodyHtml ? showInlineImages(draft.bodyHtml, images) : null });
  // A saved template's pictures arrive after it opens: shown once they do (unless the message was edited meanwhile).
  const [savedShown, setSavedShown] = useState(false);
  useEffect(() => {
    if (savedShown || draft.uploads || !Object.keys(saved).length) return;
    setSavedShown(true);
    setBody((b) => (b.html !== null && b.html === (draft.bodyHtml ?? null) ? { ...b, html: showInlineImages(b.html, saved) } : b));
  }, [saved, savedShown]);
  const [error, setError] = useState<string | null>(null);
  const editing = draft.id !== undefined;

  function submit() {
    if (!v.name.trim()) return setError(t('Give the template a name'));
    if (!v.subject.trim()) return setError(t('Enter a subject'));
    // Pictures go back to cid: (the server keeps those of the template's own inline files).
    const fields = { ...v, body: body.text, bodyHtml: body.html === null ? null : restoreCids(body.html, shownImages) };
    const files = draft.uploads ? { attachments: uploads.map(({ name, contentId, inline, data }) => ({ name, contentId, inline, data })) } : {};
    const payload = editing
      ? { ...fields, ...files, updatedAt: draft.updatedAt }
      : { ...fields, ...files, sourceType: draft.sourceType ?? 'manual', fileName: draft.fileName ?? null, fileSize: draft.fileSize ?? null };
    save.mutate(
      { id: draft.id, body: payload },
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
          <MessageEditor id="tpl-body" label={t('Body')} rows={9} value={body} onChange={setBody} />
          {draft.uploads ? (
            <AttachmentChips
              files={uploads.flatMap((f, i) => (f.inline ? [] : [{ key: i, name: f.name, size: f.size }]))}
              onRemove={(i) => setUploads(uploads.filter((_f, j) => j !== i))}
            />
          ) : (
            <AttachmentChips files={(draft.attachments ?? []).filter((a) => !a.inline).map((a) => ({ key: a.id, name: a.name, size: a.size }))} />
          )}
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
