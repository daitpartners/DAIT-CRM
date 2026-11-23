import { useState, type FormEvent } from 'react';
import { MANUAL_SOURCE_TYPES, type ManualSourceCreate } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useAddSource } from '../../api/research';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText, sourceTypeText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

type SourceType = (typeof MANUAL_SOURCE_TYPES)[number];

/** "+ Add source manually" (prototype "Add research source"): Title, URL, Type, Fields populated, and Notes (design). */
export function AddSourceModal({ companyId, onClose }: { companyId: number; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const add = useAddSource(companyId);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>(MANUAL_SOURCE_TYPES[0]);
  const [fields, setFields] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ title?: string; url?: string; form?: string }>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setErrors({ title: t('Enter a title') });
      return;
    }
    setErrors({});
    const body: ManualSourceCreate = {
      title: title.trim(),
      url: url.trim() || undefined,
      sourceType,
      fieldsPopulated: fields.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    add.mutate(body, {
      onSuccess: () => {
        toast(t('Source recorded'));
        onClose();
      },
      onError: (err) => {
        const bad = err instanceof ApiError ? (err.issues ?? []).map((i) => i.path[0]) : [];
        if (bad.includes('url')) setErrors({ url: t('Enter a valid web address, for example https://example.com') });
        else if (bad.includes('title')) setErrors({ title: t('Enter a title') });
        else setErrors({ form: errorText(t, err instanceof ApiError ? err.code : 'unknown') });
      },
    });
  }

  return (
    <Modal
      title={t('Add research source')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="source-form" className="btn primary" disabled={add.isPending}>
            {t('Add')}
          </button>
        </>
      }
    >
      <form id="source-form" noValidate onSubmit={submit} className="modal-form">
        <FormField id="src-title" label={t('Title')} required error={errors.title}>
          <input
            id="src-title"
            className={errors.title ? 'in err' : 'in'}
            value={title}
            maxLength={200}
            aria-invalid={Boolean(errors.title)}
            aria-describedby={errors.title ? 'src-title-err' : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField id="src-url" label={t('URL')} error={errors.url}>
          <input
            id="src-url"
            type="url"
            className={errors.url ? 'in err' : 'in'}
            value={url}
            maxLength={500}
            placeholder="https://"
            aria-invalid={Boolean(errors.url)}
            aria-describedby={errors.url ? 'src-url-err' : undefined}
            onChange={(e) => setUrl(e.target.value)}
          />
        </FormField>
        <div className="grid2">
          <FormField id="src-type" label={t('Type')}>
            <select id="src-type" className="in" value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
              {MANUAL_SOURCE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {sourceTypeText(t, v)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="src-fields" label={t('Fields populated')}>
            <input id="src-fields" className="in" value={fields} maxLength={500} onChange={(e) => setFields(e.target.value)} />
          </FormField>
        </div>
        <FormField id="src-notes" label={t('Notes')}>
          <textarea id="src-notes" className="in" rows={3} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        {errors.form ? (
          <div className="note warn" role="alert">
            {errors.form}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
