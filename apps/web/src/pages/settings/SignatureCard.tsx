import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useSaveSignature, useSignature } from '../../api/signature';
import { MessageEditor, type MessageValue } from '../../components/MessageEditor';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { editorText, textToEditorHtml } from '../../lib/richText';

/** A saved signature as the editor's value: its HTML, and its text read from an inert document (nothing loads). */
function editorValue(html: string | null): MessageValue {
  if (!html) return { text: '', html: '' };
  return { text: editorText(new DOMParser().parseFromString(html, 'text/html').body), html };
}

/**
 * The user's email signature (web-mail release 3), under Preferences: formatted text and links (the server drops
 * pictures), added to new emails and replies written in the CRM when Add automatically is ticked.
 */
export function SignatureCard() {
  const t = useT();
  const toast = useToast();
  const signature = useSignature();
  const save = useSaveSignature();
  // Formatted from the start: an empty signature is an empty formatted message, never the plain textarea.
  const [value, setValue] = useState<MessageValue>({ text: '', html: '' });
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!signature.data) return;
    setValue(editorValue(signature.data.html));
    setAuto(signature.data.auto);
  }, [signature.data]);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Nothing written (only empty paragraphs): no signature.
    const html = value.html && value.text.trim() ? value.html : null;
    save.mutate(
      { html, auto },
      {
        onSuccess: () => toast(t('Signature saved')),
        onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
      },
    );
  }

  return (
    <section className="card" aria-labelledby="signature-title">
      <div className="card-title-row">
        <h2 id="signature-title">{t('Email signature')}</h2>
        <span className="muted card-sub">{t('Added to new emails and replies you write in the CRM.')}</span>
      </div>
      {signature.isPending ? (
        <p className="muted none">{t('Loading…')}</p>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <MessageEditor
            id="signature-editor"
            label={t('Email signature')}
            value={value}
            // Remove formatting keeps the words as plain paragraphs: a signature stays formatted text.
            onChange={(v) => setValue(v.html === null ? { text: v.text, html: textToEditorHtml(v.text) } : v)}
            rows={5}
          />
          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t('Add automatically')}
          </label>
          <div>
            <button type="submit" className="btn primary" disabled={save.isPending}>
              {save.isPending ? t('Saving…') : t('Save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
